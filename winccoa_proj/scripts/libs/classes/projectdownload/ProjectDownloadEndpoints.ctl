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
static mapping _csrfTokens;

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
    fileToString(PROJ_PATH + DATA_REL_PATH + "html/proj.html", res);
    return res;
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
