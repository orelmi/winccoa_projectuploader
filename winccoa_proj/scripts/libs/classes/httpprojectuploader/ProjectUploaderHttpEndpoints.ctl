#uses "CtrlPv2Admin"
#uses "pmon"
#uses "CtrlHTTP"

const string DPT_PROJUP = "PROJECT_UPLOADER";

//--------------------------------------------------------------------------------
/*!
 * @brief Handler for project upload endpoints.
 */
class ProjectUploaderHttpEndpoints
{
  static const string URL_BASE = "/projectuploader/";


//@public members
  /**
    @brief Connects HTTP endpoints needed for project upload. To be called from
           `webclient_http.ctl`.
    @param httpsPort HTTPS port used by the server.
  */
  public static void connectEndpoints(int httpsPort)
  {
    if (!isEnabled())
    {
      httpConnect(httpNotFound, URL_BASE + "*", "text/html"); // "custom 404"

      throwError(makeError("", PRIO_INFO, ERR_PARAM, 0, "Project Uploader interface is disabled by config, see section [projectUploader]"));
      return;
    }
    DebugTN("httpConnect", URL_BASE);
    httpConnect(uploadform, URL_BASE + "form");
    httpConnect(fileupload, URL_BASE + "upload");
  }

  static void fileupload(blob content, string user, string ip, dyn_string headernames, dyn_string headervalues, int connIdx)
  {
    DebugTN("fileupload", content, user, ip, headernames, headervalues);
    int pos =0;
    int len = bloblen(content);
    string val;
    blobGetValue(content,pos,val,len);
    DebugN(val);
    DebugN("blobGetValue - content:", content);

    string contentType = httpGetHeader(connIdx, "Content-Type");
    int pos = strpos(contentType, "boundary=");
  // Returns the string boundary= from the string "contentType

    if (pos >= 0)
    {
      string boundary = substr(contentType, pos + 9);

  // The "boundary" parameter is a separator defined by the HTTP header, substr cuts the string "contentType" off as of "pos" + 9 characters
      DebugN("Boundary:", boundary, contentType);
  // Outputs the content of the "boundary" parameter as well as contentType

      string path = DATA_PATH + "upload_" + (long) getCurrentTime();
      if (!isdir(path))
      {
        mkdir(path, 777);
      }

      mapping result;
      DebugTN("httpSaveFilesFromUpload", path);
      int retval = httpSaveFilesFromUpload(content, boundary, path, result);
      DebugN("result", result);
      for(int i = 1; i <= mappinglen(result); i++) DebugN("mappingGetValue", i, "is =" + mappingGetValue(result,i));

      dyn_string fNames = getFileNames(path, "*.zip");
  	  file f = fopen(path + "/" + fNames[1], "rb");
  	  blob data;
  	  fread(f, data);
  	  fclose(f);

      dyn_string dps = dpNames("*", DPT_PROJUP);
      for (int i = 1; i <= dynlen(dps); i++)
      {
  	    dpSet(dps[i] + ".filedata", data,
              dps[i] + ".command", true,
              dps[i] + ".status", -1
              );
      }
    }
  }

  // See rfc1867 for detailed information on form-based file uploads in HTML
  static string uploadform()
  {

  // Form example with two fields of types "file" and "submit".
  //This means for selecting files and copying the selected data.
    string formDoc = "<html><head><title>File Upload</title>"
                     "<body><h1>"
                     "<form action=\"/projectuploader/upload\" method=\"post\" enctype=\"multipart/form-data\">"
                     "<input type=\"file\" name=\"dateiupload\"> "
                     "<input type=\"submit\" name=\"btn[upload]\"> "
                     "<td><font face=\"Arial\"><input type=\"text\" size=\"40\"  name=\"folder\" value=\"\"></font></td></form>"
                     "</body></html>";
    return formDoc;
    DebugN("Formdoc:", formDoc);
  // Returns the form
  }


//@private members
  /** Returns custom 404 error:
    @return { "errorText" : "Project uploader interface is disabled by config" }
  */
  private static string httpNotFound()
  {
    return jsonEncode(makeMapping("errorText", "Project Uploader interface is disabled by config"));
  }

  /** Determines if Project uploader interface is enabled or not. Interface is disabled by default.
    Section: httpProjectUploader
    Key: enabled
    @return true, if enabled, otherwise false.
  */
  private static bool isEnabled()
  {
    bool isDflt;
    bool enabled =paCfgReadValue(CFG_PATH, "httpProjectUploader", "enabled", true, isDflt);
    return enabled;
  }
};
