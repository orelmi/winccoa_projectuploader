#uses "pmon"
#uses "compression"

const string DPT_PROJUP = "PROJECT_UPLOADER";

string DP_PROJUP = "PROJECT_UPLOADER_001";

main(string arg)
{
	if (arg != "")
	{
		DP_PROJUP = arg;
	}
	dyn_string dpts = dpTypes(DPT_PROJUP);
	if (dynlen(dpts) == 0)
	{
		createDpType();
	}
	delay(0, 500);
	if (!dpExists(DP_PROJUP))
	{
		dpCreate(DP_PROJUP, DPT_PROJUP);
	}
	delay(0, 500);
	dpConnect("cbData", false, DP_PROJUP + ".command", DP_PROJUP + ".filedata");
}

cbData(string dp1, bool command, string dp2, blob filedata)
{
	if (command)
	{
    string path;
		int rc = unzipData(filedata);
		dpSet(
        DP_PROJUP + ".command", false,
        DP_PROJUP + ".filedata", 0,
        DP_PROJUP + ".status", rc
        );
    if (rc == 0)
    {
      restartMgr();
    }
	}
}

restartMgr()
{
  string projupcmdfile = PROJ_PATH + CONFIG_REL_PATH + "projupcmd";
  string res;
  fileToString(projupcmdfile, res);
  if (res != "")
  {
    remove(projupcmdfile);
    dyn_string parts = res.split("\n");
    for (int i = 1; i <= dynlen(parts); i++)
    {
      string cmd = parts[i];
      DebugTN("execute projupcmd", cmd);
      pmon_command(cmd, "localhost", pmonPort(), false, true);
    }
  }
}

createDpType()
{
	dyn_dyn_string xxdepes;
	dyn_dyn_int xxdepei;
	xxdepes[1] = makeDynString (DPT_PROJUP,"","","");
	xxdepes[2] = makeDynString ("","filedata","","");
	xxdepes[3] = makeDynString ("","status","","");
	xxdepes[4] = makeDynString ("","command","","");
	xxdepei[1] = makeDynInt (DPEL_STRUCT);
	xxdepei[2] = makeDynInt (0,DPEL_BLOB);
	xxdepei[3] = makeDynInt (0,DPEL_INT);
	xxdepei[4] = makeDynInt (0,DPEL_BOOL);
	dpTypeCreate(xxdepes,xxdepei);
}

int unzipData(blob data)
{
	string path = PROJ_PATH + SOURCE_REL_PATH + "upload/" + (long) getCurrentTime();

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
    Debug("Unzip failed", rc);
  }
  return rc;
}
