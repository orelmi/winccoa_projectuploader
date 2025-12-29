// $License: NOLICENSE
//--------------------------------------------------------------------------------
/**
  @file $relPath
  @copyright $copyright
  @author orelmi
  @brief HTTP endpoints for Log Viewer functionality
         Adapted from https://github.com/orelmi/winccoa_logviewer
*/

#uses "CtrlPv2Admin"
#uses "pmon"
#uses "CtrlHTTP"

//--------------------------------------------------------------------------------
/*!
 * @brief Handler for Log Viewer endpoints.
 */
class LogViewerHttpEndpoints
{
  static const string URL_BASE = "/logs";

//@public members
  /**
    @brief Connects HTTP endpoints needed for log viewer. To be called from
           `webclient_http.ctl`.
    @param httpsPort HTTPS port used by the server.
  */
  public static void connectEndpoints(int httpsPort)
  {
    if (!isEnabled())
    {
      httpConnect(httpNotFound, URL_BASE + "*", "text/html"); // "custom 404"

      throwError(makeError("", PRIO_INFO, ERR_PARAM, 0, "LogViewer interface is disabled by config, see section [httpLogViewer]"));
      return;
    }
    DebugTN("httpConnect", URL_BASE);

    httpConnect(logs, URL_BASE);
    httpConnect(logfile, URL_BASE + "/read");
    httpConnect(logPage, URL_BASE + "/logViewer.html");
    httpConnect(logFiles, URL_BASE + "/files");
  }

  /**
   * @brief Returns HTML page listing all log files
   */
  static string logs()
  {
    dyn_string files = getFileNames(LOG_REL_PATH, "*");
    string formDoc = "<html><head><title>Logs</title>"
             "<body><h1>Logs</h1>";

    formDoc +=  "<table>"
            "<tr><th>File</th><th></th><th>Filesize (Kb)</th></tr>";
    for(int i = 1; i <= dynlen(files); i++)
    {
      string filePath = LOG_REL_PATH + files[i];
      long fileSize = getFileSize(filePath) / 1024;
      formDoc +=  "<tr><td><a href=\"" + URL_BASE + "/logViewer.html?file=" + files[i] + "\">" + files[i] + "</a></td><td><a href=\"" + URL_BASE + "/read?raw&file=" + files[i] + "\">(raw)</a></td><td>" + fileSize + "</td></tr>";
    }
    formDoc +=  "</table>";
    formDoc +=   "</body></html>";
    return formDoc;
  }

  /**
   * @brief Returns the log viewer HTML page with file parameter substituted
   */
  static string logPage(dyn_string names, dyn_string values, string user, string ip, dyn_string headerNames, dyn_string headerValues, int idx)
  {
    string res;
    fileToString(PROJ_PATH + "/data/html/logViewerStandalone.html", res);
    mapping query = httpGetQuery(idx);
    res.replace("***FILE***",  query["file"]);
    return res;
  }

  /**
   * @brief Returns log file content (raw or JSON with lines)
   */
  static blob logfile(dyn_string names, dyn_string values, string user, string ip, dyn_string headerNames, dyn_string headerValues, int idx)
  {
    mapping query = httpGetQuery(idx);
    string filePath = LOG_REL_PATH + query["file"];
    int since = mappingHasKey(query, "since") ? query["since"] : 1;
    int limit = mappingHasKey(query, "limit") ? query["limit"] : 0;

    // Security: Validate file name (prevent path traversal)
    string fileName = query["file"];
    if (strpos(fileName, "..") >= 0 || strpos(fileName, "/") >= 0 || strpos(fileName, "\\") >= 0)
    {
      DebugTN("SECURITY: Invalid log file name requested:", fileName);
      mapping errorObj = makeMapping("error", "Invalid file name");
      return jsonEncode(errorObj);
    }

    if (mappingHasKey(query, "raw"))
    {
      file f = fopen(filePath, "rb");
      blob data;
      fread(f, data);
      fclose(f);
      return data;
    }

    long fileSize = getFileSize(filePath);
    dyn_string lines;
    if (fileSize > 0)
    {
      file f = fopen(filePath, "rb");

      int k = 1;
      while (!feof(f))
      {
        string res;
        int rc = fgets(res, fileSize, f);
        if (rc > 0)
        {
          if (k > since)
          {
            dynAppend(lines, res);
            if (limit > 0 && dynlen(lines) > limit)
            {
              dynRemove(lines, 1);
            }
          }
          k++;
        }
      }
      fclose(f);
    }
    mapping obj = makeMapping("lines", lines, "lastId", since + dynlen(lines));
    return jsonEncode(obj);
  }

  /**
   * @brief Returns JSON list of available log files
   */
  static string logFiles()
  {
    string logPath = LOG_REL_PATH;
    dyn_string logFileNames = getFileNames(logPath, "*");

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
    response["files"] = files;
    return jsonEncode(response);
  }

//@private members
  /** Returns custom 404 error:
    @return { "errorText" : "logviewer interface is disabled by config" }
  */
  private static string httpNotFound()
  {
    return jsonEncode(makeMapping("errorText", "Log viewer interface is disabled by config"));
  }

  /** Determines if logviewer interface is enabled or not. Interface is enabled by default.
    Section: httpLogViewer
    Key: enabled
    @return true, if enabled, otherwise false.
  */
  private static bool isEnabled()
  {
    bool isDflt;
    bool enabled = paCfgReadValueDflt(CONFIG_REL_PATH + "config", "httpLogViewer", "enabled", true, isDflt);
    return enabled;
  }
};
