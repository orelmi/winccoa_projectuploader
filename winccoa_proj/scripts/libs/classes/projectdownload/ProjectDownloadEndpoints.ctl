// $License: NOLICENSE
//--------------------------------------------------------------------------------
/**
  @file $relPath
  @copyright $copyright
  @author orelmi
*/

#uses "CtrlPv2Admin"
#uses "pmon"
#uses "CtrlHTTP"
#uses "CtrlZlib"


const string DPT_PROJDOWN = "PROJECT_DOWNLOAD";

// Debug flag for WebSocket traces
const int DEBUG_WEBSOCKET = 62;

// CSRF Token configuration
const int CSRF_TOKEN_LENGTH = 32;
const int CSRF_TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

// Static storage for CSRF tokens: mapping[token] = expiryTime
mapping _csrfTokens;

// WebSocket connections: mapping[idx] = connectionInfo
mapping _wsConnections;

// Last pmon JSON value for change detection
string _lastPmonJson;

// Log file subscriptions: mapping[idx] = mapping("file", fileName, "lastPos", filePosition)
mapping _logSubscriptions;

// Log file monitoring thread running flag
bool _logMonitorRunning = false;

/**
 * Sanitize a string to ensure it's valid UTF-8 for WebSocket transmission
 * Replaces invalid bytes with a replacement character
 * @param input The input string to sanitize
 * @return A sanitized UTF-8 string
 */
string _sanitizeForUtf8(string input)
{
  string result = "";
  int len = strlen(input);

  for (int i = 0; i < len; i++)
  {
    int charCode = input[i];

    // Valid ASCII printable characters and common control chars (tab, newline, carriage return)
    if ((charCode >= 32 && charCode <= 126) || charCode == 9 || charCode == 10 || charCode == 13)
    {
      result += substr(input, i, 1);
    }
    // Extended ASCII / potentially invalid bytes - replace with question mark
    else if (charCode >= 128 || charCode < 0)
    {
      result += "?";
    }
    // Other control characters - skip them
  }

  return result;
}

/**
 * Sanitize an array of log lines for UTF-8 transmission
 * @param lines Array of log lines to sanitize
 * @return Sanitized array of log lines
 */
dyn_string _sanitizeLogLines(dyn_string lines)
{
  dyn_string sanitizedLines;
  for (int i = 1; i <= dynlen(lines); i++)
  {
    dynAppend(sanitizedLines, _sanitizeForUtf8(lines[i]));
  }
  return sanitizedLines;
}

/**
 * Send compressed log data via WebSocket
 * Uses gzip compression for efficient transmission of log lines
 * @param idx WebSocket connection index
 * @param response Mapping containing the log response data
 * @return 0 on success, non-zero on failure
 */
int _sendCompressedLogData(int idx, mapping response)
{
  // Encode response to JSON
  string uncompressedData = jsonEncode(response);
  
  // Compress using gzip - returns int: 0 on success, -1 on error
  blob compressedData;
  bool rc = gzip(uncompressedData, compressedData);
  DebugFTN(DEBUG_WEBSOCKET, "WebSocket: gzip() rc:", rc, "input:", strlen(uncompressedData), "output:", bloblen(compressedData));

  if (!rc || bloblen(compressedData) == 0)
  {
    DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Compression failed, sending uncompressed");
    return httpWriteWebSocket(idx, uncompressedData);
  }

  // Debug: log first bytes of compressed data to identify format
  if (bloblen(compressedData) >= 2)
  {
    int pos = 0;
    char b0, b1;
    blobGetValue(compressedData, pos, b0, 1);
    blobGetValue(compressedData, pos, b1, 1);
    DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Compressed header bytes:", (int)b0, (int)b1);
  }

  // Create wrapper with compression metadata
  mapping wrapper;
  wrapper["compressed"] = true;
  wrapper["encoding"] = "gzip";
  wrapper["originalSize"] = bloblen(uncompressedData);
  wrapper["compressedSize"] = bloblen(compressedData);

  // Convert compressed blob to base64 for JSON transmission
  string base64Data = base64Encode(compressedData);
  wrapper["data"] = base64Data;

  int result = httpWriteWebSocket(idx, jsonEncode(wrapper));

  if (result == 0)
  {
    float ratio = (float)bloblen(compressedData) / (float)strlen(uncompressedData) * 100.0;
    DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Sent compressed", strlen(uncompressedData), "->", bloblen(compressedData), "bytes (" + (int)ratio + "%)");
  }

  return result;
}

/**
 * Callback for pmon datapoint changes - broadcasts to WebSocket clients
 * This function is outside the class because dpConnect cannot call static class methods
 */
void _cbPmonChanged(dyn_string dpes, dyn_string values)
{
  // Skip if no WebSocket clients connected
  if (mappinglen(_wsConnections) == 0)
  {
    return;
  }

  // Build the response JSON
  mapping response;
  response["type"] = "pmon";
  response["instances"] = makeDynMapping();

  for (int i = 1; i <= dynlen(values); i++)
  {
    if (values[i] != "")
    {
      mapping obj = jsonDecode(values[i]);
      dynAppend(response["instances"], obj);
    }
  }
  response["timestamp"] = formatTime("%Y-%m-%dT%H:%M:%S", getCurrentTime());

  string jsonResponse = jsonEncode(response);

  // Only broadcast if data actually changed
  if (jsonResponse == _lastPmonJson)
  {
    return;
  }
  _lastPmonJson = jsonResponse;

  // Send to all connected WebSocket clients
  dyn_int failedConnections;
  for (int i = 1; i <= mappinglen(_wsConnections); i++)
  {
    int connIdx = mappingGetKey(_wsConnections, i);
    int rc = httpWriteWebSocket(connIdx, jsonResponse);
    if (rc != 0)
    {
      dynAppend(failedConnections, connIdx);
    }
  }

  // Clean up failed connections
  for (int i = 1; i <= dynlen(failedConnections); i++)
  {
    mappingRemove(_wsConnections, failedConnections[i]);
  }

  if (dynlen(failedConnections) > 0)
  {
    DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Removed", dynlen(failedConnections), "failed connections");
  }

  DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Broadcasted pmon update to", mappinglen(_wsConnections), "clients");
}

/**
 * Monitor log files for changes and broadcast new lines to subscribers
 * This function runs as a background loop
 */
void _monitorLogFiles()
{
  if (_logMonitorRunning)
  {
    return; // Already running
  }

  _logMonitorRunning = true;
  DebugFTN(DEBUG_WEBSOCKET, "Log monitor: Started");

  while (_logMonitorRunning && mappinglen(_wsConnections) > 0)
  {
    // Check each subscription
    dyn_int subscriberIndices;
    dyn_string subscriberFiles;
    dyn_long subscriberPositions;

    // Collect subscriptions
    for (int i = 1; i <= mappinglen(_logSubscriptions); i++)
    {
      int idx = mappingGetKey(_logSubscriptions, i);
      mapping sub = _logSubscriptions[idx];
      dynAppend(subscriberIndices, idx);
      dynAppend(subscriberFiles, sub["file"]);
      dynAppend(subscriberPositions, sub["lastPos"]);
    }

    // Group subscribers by file to avoid reading the same file multiple times
    mapping fileSubscribers; // file -> dyn_int of subscriber indices

    for (int i = 1; i <= dynlen(subscriberIndices); i++)
    {
      string file_ = subscriberFiles[i];
      if (!mappingHasKey(fileSubscribers, file_))
      {
        fileSubscribers[file_] = makeDynInt();
      }
      dynAppend(fileSubscribers[file_], i); // Index in our arrays
    }

    // Process each file
    for (int f = 1; f <= mappinglen(fileSubscribers); f++)
    {
      string fileName = mappingGetKey(fileSubscribers, f);
      dyn_int subIndices = fileSubscribers[fileName];

      // Security: Validate file name
      if (strpos(fileName, "..") >= 0 || strpos(fileName, "/") >= 0 || strpos(fileName, "\\") >= 0)
      {
        continue;
      }

      string filePath = LOG_REL_PATH + fileName;
      if (!isfile(filePath))
      {
        continue;
      }

      long fileSize = getFileSize(filePath);

      // Find the minimum position among all subscribers for this file
      long minPos = 999999999;
      for (int s = 1; s <= dynlen(subIndices); s++)
      {
        int arrIdx = subIndices[s];
        if (subscriberPositions[arrIdx] < minPos)
        {
          minPos = subscriberPositions[arrIdx];
        }
      }

      // If file has new content
      if (fileSize > minPos)
      {
        dyn_string newLines;
        long newPos = minPos;

        // Read new lines from the file
        file logFile = fopen(filePath, "rb");
        if (logFile)
        {
          fseek(logFile, minPos, SEEK_SET);

          while (!feof(logFile))
          {
            string line;
            int rc = fgets(line, 10000, logFile);
            if (rc > 0)
            {
              dynAppend(newLines, line);
              newPos = ftell(logFile);
            }
          }
          fclose(logFile);
        }

        // Send new lines to each subscriber
        if (dynlen(newLines) > 0)
        {
          for (int s = 1; s <= dynlen(subIndices); s++)
          {
            int arrIdx = subIndices[s];
            int connIdx = subscriberIndices[arrIdx];
            long subPos = subscriberPositions[arrIdx];

            // Only send lines that are new for this subscriber
            dyn_string linesToSend;
            long currentPos = minPos;
            file logFile2 = fopen(filePath, "rb");
            if (logFile2)
            {
              fseek(logFile2, subPos, SEEK_SET);
              while (!feof(logFile2))
              {
                string line;
                int rc = fgets(line, 10000, logFile2);
                if (rc > 0)
                {
                  dynAppend(linesToSend, line);
                }
              }
              fclose(logFile2);
            }

            if (dynlen(linesToSend) > 0)
            {
              // Update subscription position
              if (mappingHasKey(_logSubscriptions, connIdx))
              {
                mapping sub = _logSubscriptions[connIdx];
                sub["lastPos"] = fileSize;
                _logSubscriptions[connIdx] = sub;
              }

              // Sanitize log lines for UTF-8 WebSocket transmission
              dyn_string sanitizedLines = _sanitizeLogLines(linesToSend);

              // Send log update via WebSocket with compression
              mapping response;
              response["type"] = "log";
              response["file"] = fileName;
              response["lines"] = sanitizedLines;
              response["lastPos"] = fileSize;
              response["timestamp"] = formatTime("%Y-%m-%dT%H:%M:%S", getCurrentTime());

              int rc = _sendCompressedLogData(connIdx, response);
              if (rc != 0)
              {
                // Connection failed, will be cleaned up later
                mappingRemove(_logSubscriptions, connIdx);
              }
            }
          }
        }
      }
    }

    delay(0, 500); // Check every 500ms
  }

  _logMonitorRunning = false;
  DebugFTN(DEBUG_WEBSOCKET, "Log monitor: Stopped");
}

/**
 * Start the log file monitor if not already running
 */
void _startLogMonitor()
{
  if (!_logMonitorRunning && mappinglen(_logSubscriptions) > 0)
  {
    startThread("_monitorLogFiles");
  }
}

//--------------------------------------------------------------------------------
/*!
 * @brief Handler for project download endpoints.
 */
class ProjectDownloadHttpEndpoints
{
  static const string URL_BASE = "/project";


//@public members
  /**
    @brief Connects HTTP endpoints needed for project download. To be called from
           `webclient_http.ctl`.
    @param httpsPort HTTPS port used by the server.
  */
  public static void connectEndpoints(int httpsPort)
  {
    if (!isEnabled())
    {
      httpConnect(httpNotFound, URL_BASE + "*", "text/html"); // "custom 404"

      throwError(makeError("", PRIO_INFO, ERR_PARAM, 0, "Project download interface is disabled by config, see section [projectDownload]"));
      return;
    }
    DebugFTN(DEBUG_WEBSOCKET, "httpConnect", URL_BASE);
    httpConnect(mainPage, URL_BASE);
    httpConnect(handleRequestDownload, URL_BASE + "/download");
    httpConnect(handleRequestRestart, URL_BASE + "/restart", "application/json");
    httpConnect(handleRequestPmon, URL_BASE + "/pmon", "application/json");
    httpConnect(handleRequestCsrfToken, URL_BASE + "/csrftoken", "application/json");
    httpConnect(handleRequestHistory, URL_BASE + "/history", "application/json");
    httpConnect(handleRequestManagerCommand, URL_BASE + "/manager", "application/json");

    // Static file endpoints for CSS and JS
    httpConnect(serveStyleCss, URL_BASE + "/css/style.css", "text/css");
    httpConnect(serveAppJs, URL_BASE + "/js/app.js", "application/javascript");

    // WebSocket endpoint for real-time updates
    httpConnect(handleWebSocket, URL_BASE + "/ws", "_websocket_");
    DebugFTN(DEBUG_WEBSOCKET, "WebSocket endpoint registered at", URL_BASE + "/ws");

    // Subscribe to pmon datapoint changes for WebSocket broadcast
    subscribeToPmonChanges();
  }

  /**
   * Subscribe to pmon datapoint changes to broadcast updates via WebSocket
   */
  private static void subscribeToPmonChanges()
  {
    dyn_string dps = dpNames("*", DPT_PROJDOWN);
    if (dynlen(dps) == 0)
    {
      DebugFTN(DEBUG_WEBSOCKET, "WebSocket: No PROJECT_DOWNLOAD datapoints found, skipping pmon subscription");
      return;
    }

    // Connect to all pmon DPEs
    dyn_string pmonDpes;
    for (int i = 1; i <= dynlen(dps); i++)
    {
      dynAppend(pmonDpes, dps[i] + ".pmon");
    }

    // Use dpConnect to monitor changes - callback is outside the class
    dpConnect("_cbPmonChanged", false, pmonDpes);
    DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Subscribed to pmon changes on", dynlen(pmonDpes), "datapoints");
  }

  static string handleRequestRestart(blob content, string user, string ip, dyn_string headernames, dyn_string headervalues, int connIdx)
  {
    // Decode blob content to string
    int pos = 0;
    int len = bloblen(content);
    string contentStr;
    blobGetValue(content, pos, contentStr, len);

    mapping obj = jsonDecode(contentStr);
    mapping response;

    // CSRF validation
    string csrfToken = obj["csrfToken"];
    if (!validateCsrfToken(csrfToken))
    {
      DebugTN("SECURITY: CSRF validation failed for restart request from", ip);
      response["success"] = false;
      response["error"] = "Invalid CSRF token";
      return jsonEncode(response);
    }

    if (obj["restart"])
    {
      string targetHostname = obj["hostname"];
      dyn_string dps = dpNames("*", DPT_PROJDOWN);
      int restartCount = 0;

      for (int i = 1; i <= dynlen(dps); i++)
      {
        // If hostname specified, only restart that instance
        if (targetHostname != "")
        {
          string pmonJson;
          dpGet(dps[i] + ".pmon", pmonJson);
          if (pmonJson != "")
          {
            mapping pmonData = jsonDecode(pmonJson);
            if (pmonData["hostname"] == targetHostname)
            {
              dpSet(dps[i] + ".restartproj", true);
              restartCount++;
              DebugTN("Restart command sent to instance:", targetHostname);
            }
          }
        }
        else
        {
          // Restart all instances
          dpSet(dps[i] + ".restartproj", true);
          restartCount++;
        }
      }

      response["success"] = true;
      response["message"] = "Restart command sent to " + restartCount + " instance(s)";
      response["count"] = restartCount;
    }
    else
    {
      response["success"] = false;
      response["error"] = "No restart command specified";
    }

    return jsonEncode(response);
  }

  /**
   * Handle manager control commands (start, stop, restart individual managers)
   * Expected JSON body: { "action": "start|stop|restart", "shmId": <int>, "hostname": "<string>", "csrfToken": "<token>" }
   */
  static string handleRequestManagerCommand(blob content, string user, string ip, dyn_string headernames, dyn_string headervalues, int connIdx)
  {
    // Decode blob content to string
    int pos = 0;
    int len = bloblen(content);
    string contentStr;
    blobGetValue(content, pos, contentStr, len);

    DebugTN("handleRequestManagerCommand received content length:", len);
    DebugTN("handleRequestManagerCommand content:", contentStr);

    mapping response;

    // Check if content is empty
    if (contentStr == "" || strlen(contentStr) == 0)
    {
      DebugTN("ERROR: Empty content received");
      response["success"] = false;
      response["error"] = "Empty request body";
      return jsonEncode(response);
    }

    mapping obj = jsonDecode(contentStr);

    // CSRF validation
    string csrfToken = obj["csrfToken"];
    if (!validateCsrfToken(csrfToken))
    {
      DebugTN("SECURITY: CSRF validation failed for manager command from", ip);
      response["success"] = false;
      response["error"] = "Invalid CSRF token";
      return jsonEncode(response);
    }

    string action = obj["action"];
    int shmId = obj["shmId"];
    string targetHostname = obj["hostname"];

    // Validate action
    if (action != "start" && action != "stop" && action != "restart")
    {
      DebugTN("SECURITY: Invalid manager action from", ip, ":", action);
      response["success"] = false;
      response["error"] = "Invalid action. Use: start, stop, or restart";
      return jsonEncode(response);
    }

    // Find the target datapoint by hostname
    dyn_string dps = dpNames("*", DPT_PROJDOWN);
    string targetDp = "";

    for (int i = 1; i <= dynlen(dps); i++)
    {
      string pmonJson;
      dpGet(dps[i] + ".pmon", pmonJson);
      if (pmonJson != "")
      {
        mapping pmonData = jsonDecode(pmonJson);
        if (pmonData["hostname"] == targetHostname)
        {
          targetDp = dps[i];
          break;
        }
      }
    }

    if (targetDp == "")
    {
      DebugTN("ERROR: No instance found for hostname:", targetHostname);
      response["success"] = false;
      response["error"] = "Instance not found: " + targetHostname;
      return jsonEncode(response);
    }

    // Build command JSON and write to target instance DP
    mapping cmdData;
    cmdData["action"] = action;
    cmdData["shmId"] = shmId;

    DebugTN("Sending manager command to", targetDp, ":", jsonEncode(cmdData));
    dpSet(targetDp + ".managerCmd", jsonEncode(cmdData));

    response["success"] = true;
    response["message"] = "Command sent: " + action + " manager " + shmId + " on " + targetHostname;

    return jsonEncode(response);
  }

  static void handleRequestDownload(blob content, string user, string ip, dyn_string headernames, dyn_string headervalues, int connIdx)
  {
//    DebugTN("handleRequestDownload", content, user, ip, headernames, headervalues);
    int pos =0;
    int len = bloblen(content);
    string val;
    blobGetValue(content,pos,val,len);
    //DebugTN(val);
    string contentType = httpGetHeader(connIdx, "Content-Type");
    int pos = strpos(contentType, "boundary=");
  // Returns the string boundary= from the string "contentType

    if (pos >= 0)
    {
      string boundary = substr(contentType, pos + 9);

  // The "boundary" parameter is a separator defined by the HTTP header, substr cuts the string "contentType" off as of "pos" + 9 characters
  //    DebugN("Boundary:", boundary, contentType);
  // Outputs the content of the "boundary" parameter as well as contentType

      string path = DATA_PATH + "download_" + (long) getCurrentTime();
      if (!isdir(path))
      {
        mkdir(path, 777);
      }

      mapping result;
      int retval = httpSaveFilesFromUpload(content, boundary, path, result);

      bool restartProject = false;
      string csrfToken = "";

      for(int i = 1; i <= mappinglen(result); i++)
      {
        DebugTN(mappingGetValue(result,i));
        mapping part = mappingGetValue(result,i);
        if (strpos(part["Content-Disposition"], "restartProject") > 0)
        {
          restartProject = (bool)part.content;
        }
        // Extract CSRF token from form data
        if (strpos(part["Content-Disposition"], "csrfToken") > 0)
        {
          csrfToken = part.content;
        }
      }

      // CSRF validation
      if (!validateCsrfToken(csrfToken))
      {
        DebugTN("SECURITY: CSRF validation failed for download request from", ip);
        httpSetResponseStatus(connIdx, 403, "Forbidden - Invalid CSRF token");
        // Clean up uploaded files
        dyn_string uploadedFiles = getFileNames(path, "*");
        for (int i = 1; i <= dynlen(uploadedFiles); i++)
        {
          remove(path + "/" + uploadedFiles[i]);
        }
        rmdir(path);
        return;
      }

      dyn_string fNames = getFileNames(path, "*.zip");
      if (dynlen(fNames) == 0)
      {
        DebugTN("SECURITY: No ZIP file found in upload from", ip);
        httpSetResponseStatus(connIdx, 400, "Bad Request - No ZIP file uploaded");
        rmdir(path);
        return;
      }

      string zipFilePath = path + "/" + fNames[1];
  	  file f = fopen(zipFilePath, "rb");
  	  blob data;
  	  fread(f, data);
  	  fclose(f);

      // Get file size for history logging
      long fileSize = getFileSize(zipFilePath);

      dyn_string dps = dpNames("*", DPT_PROJDOWN);
      for (int i = 1; i <= dynlen(dps); i++)
      {
        // Store file metadata for history logging
        dpSet(dps[i] + ".lastFileName", fNames[1],
              dps[i] + ".lastFileSize", fileSize,
              dps[i] + ".lastUser", user);

        // Trigger deployment
  	    dpSet(dps[i] + ".filedata", data,
              dps[i] + ".command", true,
              dps[i] + ".restartproj", restartProject,
              dps[i] + ".status", -1
              );
      }
    }
  }

  // See rfc1867 for detailed information on form-based file uploads in HTML
  static string mainPage()
  {
    string res;
    fileToString(getPath(DATA_REL_PATH, "html/proj.html"), res);
    return res;
  }

  /**
   * Serve the CSS stylesheet
   * @return CSS file content
   */
  static string serveStyleCss()
  {
    string res;
    fileToString(getPath(DATA_REL_PATH, "html/css/style.css"), res);
    return res;
  }

  /**
   * Serve the JavaScript application file
   * @return JavaScript file content
   */
  static string serveAppJs()
  {
    string res;
    fileToString(getPath(DATA_REL_PATH, "html/js/app.js"), res);
    return res;
  }

  /* ==========================================================================
     WebSocket Management
     ========================================================================== */

  /**
   * Handle WebSocket connections for real-time updates
   * @param map Connection mapping containing idx, headers, user, ip
   */
  static void handleWebSocket(mapping map)
  {
    int idx = map["idx"];
    string user = map["user"];
    string ip = map["ip"];

    DebugFTN(DEBUG_WEBSOCKET, "WebSocket: New connection from", ip, "user:", user, "idx:", idx);

    // Store connection info
    mapping connInfo;
    connInfo["user"] = user;
    connInfo["ip"] = ip;
    connInfo["connectedAt"] = getCurrentTime();
    _wsConnections[idx] = connInfo;

    // Send initial pmon data
    sendPmonUpdate(idx);

    // Read messages from client
    mixed message;
    while (httpReadWebSocket(idx, message) == 0)
    {
      handleWebSocketMessage(idx, message);
    }

    // Connection closed
    DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Connection closed, idx:", idx);
    mappingRemove(_wsConnections, idx);

    // Clean up any log subscriptions for this connection
    if (mappingHasKey(_logSubscriptions, idx))
    {
      mappingRemove(_logSubscriptions, idx);
      DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Cleaned up log subscription for idx:", idx);
    }
  }

  /**
   * Handle incoming WebSocket message
   * @param idx Connection index
   * @param message Received message
   */
  private static void handleWebSocketMessage(int idx, mixed message)
  {
    mapping msg;
    if (getType(message) == STRING_VAR)
    {
      msg = jsonDecode(message);
    }
    else
    {
      return;
    }

    string msgType = msg["type"];
    DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Received message type:", msgType, "from idx:", idx);

    if (msgType == "heartbeat")
    {
      // Respond to heartbeat
      mapping response;
      response["type"] = "heartbeat";
      response["timestamp"] = formatTime("%Y-%m-%dT%H:%M:%S", getCurrentTime());
      httpWriteWebSocket(idx, jsonEncode(response));
    }
    else if (msgType == "subscribe")
    {
      // Client wants to subscribe to updates - send current state
      sendPmonUpdate(idx);
    }
    else if (msgType == "getPmon")
    {
      // Client requests pmon data
      sendPmonUpdate(idx);
    }
    else if (msgType == "subscribeLog")
    {
      // Subscribe to log file updates
      string fileName = msg["file"];
      long startPos = msg["startPos"];

      // Security: Validate file name
      if (strpos(fileName, "..") >= 0 || strpos(fileName, "/") >= 0 || strpos(fileName, "\\") >= 0)
      {
        mapping errorResponse;
        errorResponse["type"] = "error";
        errorResponse["message"] = "Invalid file name";
        httpWriteWebSocket(idx, jsonEncode(errorResponse));
        return;
      }

      // Create or update subscription
      mapping sub;
      sub["file"] = fileName;
      sub["lastPos"] = startPos;
      _logSubscriptions[idx] = sub;

      DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Client", idx, "subscribed to log file:", fileName, "from position:", startPos);

      // Send initial log content
      sendLogContent(idx, fileName, startPos);

      // Start monitor if needed
      _startLogMonitor();
    }
    else if (msgType == "unsubscribeLog")
    {
      // Unsubscribe from log updates
      if (mappingHasKey(_logSubscriptions, idx))
      {
        mappingRemove(_logSubscriptions, idx);
        DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Client", idx, "unsubscribed from log updates");
      }
    }
    else if (msgType == "getLogFiles")
    {
      // Send list of available log files
      sendLogFileList(idx);
    }
  }

  /**
   * Send pmon update to a specific WebSocket client
   * @param idx Connection index
   */
  private static void sendPmonUpdate(int idx)
  {
    dyn_string dps = dpNames("*", DPT_PROJDOWN);
    dyn_string dpes;
    for (int i = 1; i <= dynlen(dps); i++)
    {
      dpes[i] = dps[i] + ".pmon";
    }
    dyn_string values;
    dpGet(dpes, values);

    mapping response;
    response["type"] = "pmon";
    response["instances"] = makeDynMapping();
    for (int i = 1; i <= dynlen(dpes); i++)
    {
      mapping obj = jsonDecode(values[i]);
      dynAppend(response["instances"], obj);
    }
    response["timestamp"] = formatTime("%Y-%m-%dT%H:%M:%S", getCurrentTime());

    httpWriteWebSocket(idx, jsonEncode(response));
  }

  /**
   * Send log file content to a specific WebSocket client
   * @param idx Connection index
   * @param fileName Log file name
   * @param startPos Starting position in the file
   */
  private static void sendLogContent(int idx, string fileName, long startPos)
  {
    string filePath = LOG_REL_PATH + fileName;

    if (!isfile(filePath))
    {
      mapping errorResponse;
      errorResponse["type"] = "error";
      errorResponse["message"] = "File not found: " + fileName;
      httpWriteWebSocket(idx, jsonEncode(errorResponse));
      return;
    }

    long fileSize = getFileSize(filePath);
    dyn_string lines;

    file logFile = fopen(filePath, "rb");
    if (logFile)
    {
      if (startPos > 0 && startPos < fileSize)
      {
        fseek(logFile, startPos, SEEK_SET);
      }

      while (!feof(logFile))
      {
        string line;
        int rc = fgets(line, 10000, logFile);
        if (rc > 0)
        {
          dynAppend(lines, line);
        }
      }
      fclose(logFile);
    }

    // Update subscription with current file position
    if (mappingHasKey(_logSubscriptions, idx))
    {
      mapping sub = _logSubscriptions[idx];
      sub["lastPos"] = fileSize;
      _logSubscriptions[idx] = sub;
    }

    // Sanitize log lines for UTF-8 WebSocket transmission
    dyn_string sanitizedLines = _sanitizeLogLines(lines);

    mapping response;
    response["type"] = "logContent";
    response["file"] = fileName;
    response["lines"] = sanitizedLines;
    response["lastPos"] = fileSize;
    response["timestamp"] = formatTime("%Y-%m-%dT%H:%M:%S", getCurrentTime());

    // Use compression for log data transmission
    _sendCompressedLogData(idx, response);
    DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Sent", dynlen(lines), "log lines to client", idx);
  }

  /**
   * Send list of available log files to a WebSocket client
   * @param idx Connection index
   */
  private static void sendLogFileList(int idx)
  {
    dyn_string logFileNames = getFileNames(LOG_REL_PATH, "*");

    dyn_mapping files;
    for (int i = 1; i <= dynlen(logFileNames); i++)
    {
      string filePath = getPath(LOG_REL_PATH, logFileNames[i]);
      mapping fileInfo;
      fileInfo["name"] = logFileNames[i];
      fileInfo["size"] = getFileSize(filePath) / 1024; // KB
      fileInfo["modified"] = (string)getFileModificationTime(filePath);
      dynAppend(files, fileInfo);
    }

    // Sort by modification time (newest first)
    for (int i = 1; i <= dynlen(files) - 1; i++)
    {
      for (int j = i + 1; j <= dynlen(files); j++)
      {
        if (files[j]["modified"] > files[i]["modified"])
        {
          mapping temp = files[i];
          files[i] = files[j];
          files[j] = temp;
        }
      }
    }

    mapping response;
    response["type"] = "logFiles";
    response["files"] = files;
    response["timestamp"] = formatTime("%Y-%m-%dT%H:%M:%S", getCurrentTime());

    httpWriteWebSocket(idx, jsonEncode(response));
  }

  /**
   * Broadcast pmon update to all connected WebSocket clients
   * Call this function when pmon data changes
   */
  public static void broadcastPmonUpdate()
  {
    if (mappinglen(_wsConnections) == 0)
    {
      return;
    }

    dyn_string dps = dpNames("*", DPT_PROJDOWN);
    dyn_string dpes;
    for (int i = 1; i <= dynlen(dps); i++)
    {
      dpes[i] = dps[i] + ".pmon";
    }
    dyn_string values;
    dpGet(dpes, values);

    mapping response;
    response["type"] = "pmon";
    response["instances"] = makeDynMapping();
    for (int i = 1; i <= dynlen(dpes); i++)
    {
      mapping obj = jsonDecode(values[i]);
      dynAppend(response["instances"], obj);
    }
    response["timestamp"] = formatTime("%Y-%m-%dT%H:%M:%S", getCurrentTime());

    string jsonResponse = jsonEncode(response);

    // Send to all connected clients
    for (int i = 1; i <= mappinglen(_wsConnections); i++)
    {
      int connIdx = mappingGetKey(_wsConnections, i);
      httpWriteWebSocket(connIdx, jsonResponse);
    }

    DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Broadcasted pmon update to", mappinglen(_wsConnections), "clients");
  }

  /**
   * Broadcast deployment status update to all connected clients
   * @param status Deployment status (started, progress, completed, failed)
   * @param details Additional details mapping
   */
  public static void broadcastDeploymentUpdate(string status, mapping details)
  {
    if (mappinglen(_wsConnections) == 0)
    {
      return;
    }

    mapping response;
    response["type"] = "deployment";
    response["status"] = status;
    response["details"] = details;
    response["timestamp"] = formatTime("%Y-%m-%dT%H:%M:%S", getCurrentTime());

    string jsonResponse = jsonEncode(response);

    for (int i = 1; i <= mappinglen(_wsConnections); i++)
    {
      int connIdx = mappingGetKey(_wsConnections, i);
      httpWriteWebSocket(connIdx, jsonResponse);
    }

    DebugFTN(DEBUG_WEBSOCKET, "WebSocket: Broadcasted deployment update:", status);
  }

  /**
   * Get number of connected WebSocket clients
   * @return Number of active connections
   */
  public static int getWebSocketClientCount()
  {
    return mappinglen(_wsConnections);
  }

  static string handleRequestPmon()
  {
    dyn_string dps = dpNames("*", DPT_PROJDOWN);
    dyn_string dpes;
    for (int i = 1; i <= dynlen(dps); i++)
    {
      dpes[i] = dps[i] + ".pmon";
    }
    dyn_string values;
    dpGet(dpes, values);
    mapping res;
    res["instances"] = makeDynMapping();
    for (int i = 1; i <= dynlen(dpes); i++)
    {
      mapping obj = jsonDecode(values[i]);
      dynAppend(res["instances"], obj);
    }
    return jsonEncode(res);
  }

  /**
   * Handle request for deployment history
   * @return JSON with deployment history from all instances
   */
  static string handleRequestHistory()
  {
    dyn_string dps = dpNames("*", DPT_PROJDOWN);
    dyn_mapping allHistory;

    for (int i = 1; i <= dynlen(dps); i++)
    {
      string historyJson;
      dpGet(dps[i] + ".history", historyJson);

      if (historyJson != "")
      {
        dyn_mapping instanceHistory = jsonDecode(historyJson);
        // Merge into allHistory (interleave by timestamp)
        for (int j = 1; j <= dynlen(instanceHistory); j++)
        {
          dynAppend(allHistory, instanceHistory[j]);
        }
      }
    }

    // Sort by timestamp (newest first)
    for (int i = 1; i <= dynlen(allHistory) - 1; i++)
    {
      for (int j = i + 1; j <= dynlen(allHistory); j++)
      {
        if (allHistory[j]["timestamp"] > allHistory[i]["timestamp"])
        {
          mapping temp = allHistory[i];
          allHistory[i] = allHistory[j];
          allHistory[j] = temp;
        }
      }
    }

    mapping response;
    response["history"] = allHistory;
    response["totalCount"] = dynlen(allHistory);
    return jsonEncode(response);
  }


//@private members
  /** Returns custom 404 error:
    @return { "errorText" : "project download interface is disabled by config" }
  */
  private static string httpNotFound()
  {
    return jsonEncode(makeMapping("errorText", "Project Download interface is disabled by config"));
  }

  /** Determines if project download interface is enabled or not. Interface is disabled by default.
    Section: restReporting
    Key: enabled
    @return true, if enabled, otherwise false.
  */
  private static bool isEnabled()
  {
    bool isDflt;
    bool enabled =paCfgReadValueDflt(CONFIG_REL_PATH + "config", "httpProjectDownload", "enabled", true, isDflt);
    return enabled;
  }

  /* ==========================================================================
     CSRF Token Management
     ========================================================================== */

  /**
   * Handle request for a new CSRF token
   * @return JSON with the new token
   */
  static string handleRequestCsrfToken()
  {
    DebugTN("handleRequestCsrfToken called");
    string token = generateCsrfToken();
    mapping response;
    response["csrfToken"] = token;
    response["expiresIn"] = CSRF_TOKEN_EXPIRY_SECONDS;
    string result = jsonEncode(response);
    DebugTN("handleRequestCsrfToken returning:", result);
    return result;
  }

  /**
   * Generate a cryptographically secure random token
   * @return The generated token string
   */
  private static string generateCsrfToken()
  {
    // Clean expired tokens first
    cleanExpiredTokens();

    // Generate random bytes and convert to hex
    string token = "";
    for (int i = 0; i < CSRF_TOKEN_LENGTH; i++)
    {
      int randomByte = rand() % 256;
      string buf;
      sprintf(buf, "%02x", randomByte);
      token += buf;
    }

    // Store token with expiry time
    time expiryTime = getCurrentTime() + CSRF_TOKEN_EXPIRY_SECONDS;
    _csrfTokens[token] = expiryTime;

    DebugTN("CSRF: Generated new token, expires at", expiryTime);
    return token;
  }

  /**
   * Validate a CSRF token
   * @param token The token to validate
   * @return true if valid and not expired, false otherwise
   */
  private static bool validateCsrfToken(string token)
  {
    if (token == "" || strlen(token) == 0)
    {
      DebugTN("CSRF: Empty token provided");
      return false;
    }

    // Clean expired tokens
    cleanExpiredTokens();

    // Check if token exists
    if (!mappingHasKey(_csrfTokens, token))
    {
      DebugTN("CSRF: Token not found in registry");
      return false;
    }

    // Token is valid - remove it to prevent reuse (one-time use)
    mappingRemove(_csrfTokens, token);
    DebugTN("CSRF: Token validated and consumed");
    return true;
  }

  /**
   * Remove expired tokens from the registry
   */
  private static void cleanExpiredTokens()
  {
    time now = getCurrentTime();
    dyn_string tokensToRemove;

    for (int i = 1; i <= mappinglen(_csrfTokens); i++)
    {
      string key = mappingGetKey(_csrfTokens, i);
      time expiryTime = _csrfTokens[key];

      if (expiryTime < now)
      {
        dynAppend(tokensToRemove, key);
      }
    }

    for (int i = 1; i <= dynlen(tokensToRemove); i++)
    {
      mappingRemove(_csrfTokens, tokensToRemove[i]);
    }

    if (dynlen(tokensToRemove) > 0)
    {
      DebugTN("CSRF: Cleaned", dynlen(tokensToRemove), "expired tokens");
    }
  }
};
