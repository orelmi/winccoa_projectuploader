#uses "pmon"
#uses "compression"

const string DPT_PROJDOWN = "PROJECT_DOWNLOAD";
string DP_PROJDOWN = "PROJECT_DOWNLOAD_001";
const string PMON_DEPLOY_FILE = PROJ_PATH + CONFIG_REL_PATH + "pmondeploy.txt";
const string INSTALL_FILE = PROJ_PATH + CONFIG_REL_PATH + "install.bat";
const string CONFIG_ENV_FILE = PROJ_PATH + CONFIG_REL_PATH + "config.env.bat";

// Security: Allowed file extensions (whitelist)
const dyn_string ALLOWED_EXTENSIONS = makeDynString(
  ".ctl",      // Control scripts
  ".pnl",      // Panels
  ".xml",      // XML config files
  ".txt",      // Text files
  ".bat",      // Batch scripts
  ".cmd",      // Command scripts
  ".dpl",      // Datapoint lists
  ".cat",      // Catalog files
  ".png",      // Images
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".bmp",
  ".css",      // Web assets
  ".js",
  ".html",
  ".htm",
  ".json",
  ".md",       // Documentation
  ".ini",      // Config files
  ".cfg",
  ".conf"
);

// Security: Blocked patterns in file paths
const dyn_string BLOCKED_PATH_PATTERNS = makeDynString(
  "..",           // Path traversal
  "..\\",         // Windows path traversal
  "../",          // Unix path traversal
  "..%2f",        // URL encoded
  "..%5c",        // URL encoded backslash
  "%2e%2e",       // Double dot URL encoded
  "....//",       // Double encoding bypass
  "....\\\\",     // Double encoding bypass Windows
  "/etc/",        // System paths
  "C:\\Windows",  // Windows system
  "C:\\Program"   // Windows programs
);

bool _running;

main(string arg)
{
  if (arg != "")
  {
    DP_PROJDOWN = arg;
  }
	dyn_string dpts = dpTypes(DPT_PROJDOWN);
	initDpType(dynlen(dpts) == 0);
	delay(0, 500);
	if (!dpExists(DP_PROJDOWN))
	{
		dpCreate(DP_PROJDOWN, DPT_PROJDOWN);
	}
	delay(0, 500);
	dpConnect("cbData", false, DP_PROJDOWN + ".command", DP_PROJDOWN + ".filedata", DP_PROJDOWN + ".restartproj");

  sysConnect("cbExitRequested", "exitRequested");

  _running = true;
  while (_running)
  {
    refreshPmon();
    delay(1);
  }
}

cbExitRequested(string event, int exitCode)
{
  _running = false;
}

cbData(string dp1, bool command, string dp2, blob filedata, string dp3, bool restartproj)
{
  if (restartproj && !command)
  {
    restartProject();
    return;
  }
	if (command)
	{
    // Get file metadata stored by HTTP handler
    string fileName, user;
    int fileSize;
    dpGet(DP_PROJDOWN + ".lastFileName", fileName,
          DP_PROJDOWN + ".lastFileSize", fileSize,
          DP_PROJDOWN + ".lastUser", user);

    string path;
		int rc = unzipData(filedata);

    // Determine status message
    string statusMessage = "";
    if (rc == 0)
    {
      statusMessage = "Deployment successful";
    }
    else if (rc == -100)
    {
      statusMessage = "Security validation failed";
    }
    else
    {
      statusMessage = "Extraction error: " + rc;
    }

    // Log the deployment
    logDeployment(fileName, fileSize, user, rc, statusMessage);

		dpSet(
        DP_PROJDOWN + ".command", false,
        DP_PROJDOWN + ".filedata", "",
        DP_PROJDOWN + ".restartproj", false,
        DP_PROJDOWN + ".status", rc
        );
    if (rc == 0)
    {
      configEnv();
      install();
      postDeploy();
      if (restartproj)
      {
        restartProject();
      }
    }
	}
}

systemCommand(string command)
{
  string drive = substr(PROJ_PATH, 0, 2);
  string path = substr(PROJ_PATH, 2);
  system(drive + " && cd " + path + " && " + command);
}

configEnv()
{
  if (isfile(CONFIG_ENV_FILE))
  {
    systemCommand(CONFIG_ENV_FILE);
  }
}

/* execute install.bat if exists

   install.bat can contain multiple ASCII command line
   ex: "WCCOAasciiSQLite -currentproj -in dplist/update_YYYYmmdd/*.dpl"
*/
install()
{
  if (isfile(INSTALL_FILE))
  {
    systemCommand(INSTALL_FILE);
    remove(INSTALL_FILE);
  }
}

postDeploy()
{
  if (isfile(PMON_DEPLOY_FILE))
  {
    string res;
    fileToString(PMON_DEPLOY_FILE, res);
    remove(PMON_DEPLOY_FILE);
    if (res != "")
    {
      dyn_string parts = res.split("\n");
      for (int i = 1; i <= dynlen(parts); i++)
      {
        string cmd = parts[i];
        DebugTN("execute WCCILpmon command : '" + cmd + "'");
        pmon_command(cmd, "localhost", pmonPort(), false, true);
      }
    }
  }
}

restartProject()
{
  pmon_command("##RESTART_ALL:", "localhost", pmonPort(), false, true);
}

initDpType(bool create)
{
	dyn_dyn_string xxdepes;
	dyn_dyn_int xxdepei;
	xxdepes[1] = makeDynString (DPT_PROJDOWN,"","","");
	xxdepes[2] = makeDynString ("","filedata","","");
	xxdepes[3] = makeDynString ("","status","","");
	xxdepes[4] = makeDynString ("","command","","");
	xxdepes[5] = makeDynString ("","restartproj","","");
  xxdepes[6] = makeDynString ("","pmon","","");
  xxdepes[7] = makeDynString ("","history","","");
  xxdepes[8] = makeDynString ("","lastFileName","","");
  xxdepes[9] = makeDynString ("","lastFileSize","","");
  xxdepes[10] = makeDynString ("","lastUser","","");
	xxdepei[1] = makeDynInt (DPEL_STRUCT);
	xxdepei[2] = makeDynInt (0,DPEL_BLOB);
	xxdepei[3] = makeDynInt (0,DPEL_INT);
	xxdepei[4] = makeDynInt (0,DPEL_BOOL);
	xxdepei[5] = makeDynInt (0,DPEL_BOOL);
	xxdepei[6] = makeDynInt (0,DPEL_STRING);
  xxdepei[7] = makeDynInt (0,DPEL_STRING);
  xxdepei[8] = makeDynInt (0,DPEL_STRING);
  xxdepei[9] = makeDynInt (0,DPEL_INT);
  xxdepei[10] = makeDynInt (0,DPEL_STRING);
  if (create)
  {
  	dpTypeCreate(xxdepes,xxdepei);
  } else {
    dpTypeChange(xxdepes,xxdepei);
  }
}

/* ==========================================================================
   Deployment History Functions
   ========================================================================== */

// Maximum number of history entries to keep
const int MAX_HISTORY_ENTRIES = 100;

/**
 * Log a deployment event to history
 * @param fileName Name of the uploaded file
 * @param fileSize Size of the file in bytes
 * @param user Username who performed the upload
 * @param status Deployment status (0=success, negative=error)
 * @param statusMessage Optional status message
 */
void logDeployment(string fileName, long fileSize, string user, int status, string statusMessage = "")
{
  // Get current history
  string historyJson;
  dpGet(DP_PROJDOWN + ".history", historyJson);

  dyn_mapping history;
  if (historyJson != "")
  {
    history = jsonDecode(historyJson);
  }

  // Create new entry
  mapping entry;
  entry["timestamp"] = formatTime("%Y-%m-%d %H:%M:%S", getCurrentTime());
  entry["fileName"] = fileName;
  entry["fileSize"] = fileSize;
  entry["user"] = (user != "") ? user : "unknown";
  entry["status"] = status;
  entry["statusText"] = (status == 0) ? "Success" : "Failed";
  entry["statusMessage"] = statusMessage;
  entry["hostname"] = getHostname();

  // Insert at beginning (newest first)
  dynInsertAt(history, entry, 1);

  // Trim to max entries
  while (dynlen(history) > MAX_HISTORY_ENTRIES)
  {
    dynRemove(history, dynlen(history));
  }

  // Save history
  dpSet(DP_PROJDOWN + ".history", jsonEncode(history));

  DebugTN("Deployment logged:", fileName, "Status:", status);
}

/* ==========================================================================
   Security: ZIP Validation Functions
   ========================================================================== */

/**
 * Check if a file path contains path traversal patterns
 * @param filePath The file path to check
 * @return true if path is safe, false if malicious pattern detected
 */
bool isPathSafe(string filePath)
{
  string lowerPath = strtolower(filePath);

  for (int i = 1; i <= dynlen(BLOCKED_PATH_PATTERNS); i++)
  {
    if (strpos(lowerPath, strtolower(BLOCKED_PATH_PATTERNS[i])) >= 0)
    {
      DebugTN("SECURITY WARNING: Blocked path pattern detected:", BLOCKED_PATH_PATTERNS[i], "in", filePath);
      return false;
    }
  }
  return true;
}

/**
 * Check if a file extension is in the allowed list
 * @param filePath The file path to check
 * @return true if extension is allowed, false otherwise
 */
bool isExtensionAllowed(string filePath)
{
  // Allow directories (no extension check needed)
  if (filePath[strlen(filePath) - 1] == "/" || filePath[strlen(filePath) - 1] == "\\")
  {
    return true;
  }

  string lowerPath = strtolower(filePath);

  for (int i = 1; i <= dynlen(ALLOWED_EXTENSIONS); i++)
  {
    string ext = strtolower(ALLOWED_EXTENSIONS[i]);
    int extLen = strlen(ext);
    int pathLen = strlen(lowerPath);

    if (pathLen >= extLen)
    {
      if (substr(lowerPath, pathLen - extLen, extLen) == ext)
      {
        return true;
      }
    }
  }

  DebugTN("SECURITY WARNING: File extension not allowed:", filePath);
  return false;
}

/**
 * Validate all entries in a ZIP file before extraction
 * @param zipPath Path to the ZIP file
 * @param errors Output: list of validation errors
 * @return 0 if valid, negative error code otherwise
 */
int validateZipContents(string zipPath, dyn_string &errors)
{
  errors = makeDynString();

  // Get list of files in the ZIP
  dyn_string zipContents;
  int rc = zipList(zipPath, zipContents);

  if (rc != 0)
  {
    dynAppend(errors, "Failed to read ZIP contents, error code: " + rc);
    return -1;
  }

  bool hasSecurityIssue = false;

  for (int i = 1; i <= dynlen(zipContents); i++)
  {
    string entry = zipContents[i];

    // Check for path traversal
    if (!isPathSafe(entry))
    {
      dynAppend(errors, "Path traversal attempt: " + entry);
      hasSecurityIssue = true;
    }

    // Check file extension (skip directories)
    if (!isExtensionAllowed(entry))
    {
      dynAppend(errors, "Blocked file type: " + entry);
      hasSecurityIssue = true;
    }
  }

  if (hasSecurityIssue)
  {
    DebugTN("SECURITY: ZIP validation failed with", dynlen(errors), "errors");
    return -2;
  }

  DebugTN("SECURITY: ZIP validation passed,", dynlen(zipContents), "files checked");
  return 0;
}

/* ==========================================================================
   ZIP Extraction
   ========================================================================== */

int unzipData(blob data)
{
	string path = PROJ_PATH + SOURCE_REL_PATH + "download/" + (long) getCurrentTime();

	if (!isdir(path))
	{
		mkdir(path, 777);
	}

	string filePath = path + "/project.zip";
	file f = fopen(filePath, "wb");
	fwrite(f, data);
	fclose(f);

	DebugTN("Validating ZIP file:", filePath);

  // Security: Validate ZIP contents before extraction
  dyn_string validationErrors;
  int validationResult = validateZipContents(filePath, validationErrors);

  if (validationResult != 0)
  {
    DebugTN("SECURITY: ZIP validation failed!");
    for (int i = 1; i <= dynlen(validationErrors); i++)
    {
      DebugTN("  - " + validationErrors[i]);
    }
    // Clean up the invalid ZIP file
    remove(filePath);
    return -100; // Security validation error
  }

	DebugTN("Unzip file ", filePath, PROJ_PATH);
  int rc = unzip(filePath, PROJ_PATH);
  if (rc != 0)
  {
    DebugTN("Unzip failed", rc);
  }
  return rc;
}

refreshPmon()
{
  dyn_dyn_string dds;
  //DebugTN("pmon_query", pmonPort());

  dyn_mapping out;
  pmon_query2("##MGRLIST:LIST", "localhost", pmonPort(), dds);
  for (int i = 1; i <= dynlen(dds) - 1; i++)
  {
    mapping row = makeMapping("manager", dds[i][1],
                          "startMode", dds[i][2],
                          "secKill", dds[i][3],
                          "restartCount", dds[i][4],
                          "resetMin", dds[i][5]
                          );
    if (dynlen(dds[i]) >= 6)
    {
      row["commandlineOptions"] = dds[i][6];
    }
    dynAppend(out, row);
  }

  pmon_query2("##MGRLIST:STATI", "localhost", pmonPort(), dds);
  for (int i = 1; i <= dynlen(dds) - 1; i++)
  {
    out[i]["state"] = dds[i][1];
    out[i]["pid"] = dds[i][2];
    out[i]["startTime"] = dds[i][4];
    out[i]["manNum"] = dds[i][5];
    out[i]["shmId"] = i;
  }

  pmon_query2("##PROJECT:", "localhost", pmonPort(), dds);
  string projectName = dds[1][1];

  mapping res;
  res["hostname"] = getHostname();
  res["projectName"] = projectName;
  res["project"] = makeMapping();
  res["progs"] = out;

  dpSet(DP_PROJDOWN + ".pmon", jsonEncode(res));
}
