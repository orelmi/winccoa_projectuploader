#uses "pmon"
#uses "compression"

const string DPT_PROJDOWN = "PROJECT_DOWNLOAD";
string DP_PROJDOWN = "PROJECT_DOWNLOAD_001";
const string PMON_DEPLOY_FILE = PROJ_PATH + CONFIG_REL_PATH + "pmondeploy.txt";
const string CONFIG_ENV_FILE = PROJ_PATH + CONFIG_REL_PATH + "config.env.bat";

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
}

cbData(string dp1, bool command, string dp2, blob filedata, string dp3, bool restartproj)
{
	if (command)
	{
    string path;
		int rc = unzipData(filedata);
		dpSet(
        DP_PROJDOWN + ".command", false,
        DP_PROJDOWN + ".filedata", 0,
        DP_PROJDOWN + ".restartproj", false,
        DP_PROJDOWN + ".status", rc
        );
    if (rc == 0)
    {
      configEnv();
      postDeploy();
      if (restartproj)
      {
        restartProject();
      }
    }
	}
}

configEnv()
{
  if (isfile(CONFIG_ENV_FILE))
  {
    system(CONFIG_ENV_FILE);
  }
}

postDeploy()
{
  if (isfile(PMON_DEPLOY_FILE))
  {
    string res;
    fileToString(PMON_DEPLOY_FILE, res);
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
	xxdepei[1] = makeDynInt (DPEL_STRUCT);
	xxdepei[2] = makeDynInt (0,DPEL_BLOB);
	xxdepei[3] = makeDynInt (0,DPEL_INT);
	xxdepei[4] = makeDynInt (0,DPEL_BOOL);
	xxdepei[5] = makeDynInt (0,DPEL_BOOL);
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
