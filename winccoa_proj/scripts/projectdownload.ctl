#uses "pmon"
#uses "compression"

const string DPT_PROJDOWN = "PROJECT_DOWNLOAD";
string DP_PROJDOWN = "PROJECT_DOWNLOAD_001";
const string PMON_DEPLOY_FILE = PROJ_PATH + CONFIG_REL_PATH + "pmondeploy.txt";
const string INSTALL_FILE = PROJ_PATH + CONFIG_REL_PATH + "install.bat";
const string CONFIG_ENV_FILE = PROJ_PATH + CONFIG_REL_PATH + "config.env.bat";

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
    string path;
		int rc = unzipData(filedata);
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
	xxdepei[1] = makeDynInt (DPEL_STRUCT);
	xxdepei[2] = makeDynInt (0,DPEL_BLOB);
	xxdepei[3] = makeDynInt (0,DPEL_INT);
	xxdepei[4] = makeDynInt (0,DPEL_BOOL);
	xxdepei[5] = makeDynInt (0,DPEL_BOOL);
	xxdepei[6] = makeDynInt (0,DPEL_STRING);
  if (create)
  {
  	dpTypeCreate(xxdepes,xxdepei);
  } else {
    dpTypeChange(xxdepes,xxdepei);
  }
}

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
