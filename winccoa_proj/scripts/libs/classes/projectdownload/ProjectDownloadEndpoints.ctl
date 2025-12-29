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

const string DPT_PROJDOWN = "PROJECT_DOWNLOAD";

// CSRF Token configuration
const int CSRF_TOKEN_LENGTH = 32;
const int CSRF_TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

// Static storage for CSRF tokens: mapping[token] = expiryTime
mapping _csrfTokens;

// WebSocket connections: mapping[idx] = connectionInfo
mapping _wsConnections;

// Last pmon JSON value for change detection
string _lastPmonJson;

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
    DebugTN("WebSocket: Removed", dynlen(failedConnections), "failed connections");
  }

  DebugTN("WebSocket: Broadcasted pmon update to", mappinglen(_wsConnections), "clients");
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
    DebugTN("httpConnect", URL_BASE);
    httpConnect(mainPage, URL_BASE);
    httpConnect(handleRequestDownload, URL_BASE + "/download");
    httpConnect(handleRequestRestart, URL_BASE + "/restart");
    httpConnect(handleRequestPmon, URL_BASE + "/pmon");
    httpConnect(handleRequestCsrfToken, URL_BASE + "/csrf-token");
    httpConnect(handleRequestHistory, URL_BASE + "/history");

    // Static file endpoints for CSS and JS
    httpConnect(serveStyleCss, URL_BASE + "/css/style.css", "text/css");
    httpConnect(serveAppJs, URL_BASE + "/js/app.js", "application/javascript");

    // WebSocket endpoint for real-time updates
    httpConnect(handleWebSocket, URL_BASE + "/ws", "_websocket_");
    DebugTN("WebSocket endpoint registered at", URL_BASE + "/ws");

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
      DebugTN("WebSocket: No PROJECT_DOWNLOAD datapoints found, skipping pmon subscription");
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
    DebugTN("WebSocket: Subscribed to pmon changes on", dynlen(pmonDpes), "datapoints");
  }

  static void handleRequestRestart(string content, string user, string ip, dyn_string headernames, dyn_string headervalues, int connIdx)
  {
    mapping obj = jsonDecode(content);

    // CSRF validation
    string csrfToken = obj["csrfToken"];
    if (!validateCsrfToken(csrfToken))
    {
      DebugTN("SECURITY: CSRF validation failed for restart request from", ip);
      httpSetResponseStatus(connIdx, 403, "Forbidden - Invalid CSRF token");
      return;
    }

    if (obj.restart)
    {
      dyn_string dps = dpNames("*", DPT_PROJDOWN);
      for (int i = 1; i <= dynlen(dps); i++)
      {
  	    dpSet(dps[i] + ".restartproj", true);
      }
    }
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

    DebugTN("WebSocket: New connection from", ip, "user:", user, "idx:", idx);

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
    DebugTN("WebSocket: Connection closed, idx:", idx);
    mappingRemove(_wsConnections, idx);
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
    DebugTN("WebSocket: Received message type:", msgType, "from idx:", idx);

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

    DebugTN("WebSocket: Broadcasted pmon update to", mappinglen(_wsConnections), "clients");
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

    DebugTN("WebSocket: Broadcasted deployment update:", status);
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
    string token = generateCsrfToken();
    mapping response;
    response["csrfToken"] = token;
    response["expiresIn"] = CSRF_TOKEN_EXPIRY_SECONDS;
    return jsonEncode(response);
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
      token += sprintf("%02x", randomByte);
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
