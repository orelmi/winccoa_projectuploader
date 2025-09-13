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
    httpConnect(handleRequest, URL_BASE + "/download");
  }

  static void handleRequest(blob content, string user, string ip, dyn_string headernames, dyn_string headervalues, int connIdx)
  {
    DebugTN("handlRequest", content, user, ip, headernames, headervalues);
    int pos =0;
    int len = bloblen(content);
    string val;
    blobGetValue(content,pos,val,len);
    DebugTN(val);
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
      for(int i = 1; i <= mappinglen(result); i++)
      {
        DebugTN(mappingGetValue(result,i));
        mapping part = mappingGetValue(result,i);
        if (strpos(part["Content-Disposition"], "restartProject") > 0)
        {
          restartProject = (bool)part.content;
        }
      }

      dyn_string fNames = getFileNames(path, "*.zip");
  	  file f = fopen(path + "/" + fNames[1], "rb");
  	  blob data;
  	  fread(f, data);
  	  fclose(f);

      dyn_string dps = dpNames("*", DPT_PROJDOWN);
      for (int i = 1; i <= dynlen(dps); i++)
      {
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
};
