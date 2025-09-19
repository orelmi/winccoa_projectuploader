# WinCC OA Project manager

A lightweight http handler for project management.



## 🚀 Features

### Download tab
- web page allowing you to download a ZIP file
- automatic decompression of ZIP in the project tree
- option to restart the project after download
- special file ``config.env.bat`` started after download, copy files from sub-folder for current hostname in config directory (support FQDN and netbios name). This allow copy of new config or progs files.
- special file ``install.bat`` allows to define command lines to import dplist/* (see example)
- special file ``pmondeploy.txt`` allows to define special commands for WCCILpmon (restart a manager) at the end of download
- handle multiple servers in case of remote managers by using a datapoint to distribute the ZIP file to each servers.

![Download tab](assets/downloadTab.png)

### Console tab
- web page display winccoa console with manager's data
- button to restart the project

![Download tab](assets/consoleTab.png)

### Log Viewer tab
- coming soon ... will be merged from https://github.com/orelmi/winccoa_logviewer

## 🛠️ Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/orelmi/winccoa_projectuploader.git
   ```
2. Copy files to project folder

3. Add Control Manager with options ```webclient_http.ctl```

4. Add Control Manager with options ```projectdownload.ctl PROJ_SRV_A -num 98```. In case of remote projects take care to use different names of datapoint and man num in command line

## 📄 Usage

To use the project management :

1. Open URL https://localhost/project in any modern browser (Chrome, Firefox, Edge).
2. The page displays the management page
3. Download tab :
   * Select a file
   * Click on submit
4. Console tab

## Technical details

``projectdownload.ctl`` automatically create DPT and DP following argument given in Control Manager options

DPT and DP

![Para page](assets/page_para.png)

Zip file is transmitted to ``projectdownload.ctl`` CTRL as a blob in ``filedata`` DPE allowing to use the project uploader in an architecture composed of a Remote Http Server and a WinCC OA Server.

In case of multiple servers (distribution, remote proxy, dedicated http server), the blob of ZIP file is sent to all DPE of DPT ``PROJECT_DOWNLOAD``. This allows to sent a ZIP file with new scripts, panels, pictures and deploy them everywhere.

A special file ``pmondeploy.txt`` case be sent in ``config`` folder or sub-folder by hostname and could contains a list of Pmon commands.

Stop the 6th manager in the console after deploy. Restarting is automatic if Always mode was configured
```
##SINGLE_MGR:STOP 6
```

Restart all managers after deploy
```
##RESTART_ALL:
```


## 📸 Screenshots

projectdownload.ctl in the Console
![Console page](assets/page_console.png)

## Limitations

1. Unable to update database due to lock. 
2. Web form is not secured. DON'T USE IT IN PRODUCTION !!!!

## Roadmap

1. Download directly from Gedi (menu extension).
2. Add options to keep or replace database.
3. Add pmon authentication to secure project download.
4. Support of redundancy.
5. Support of distributed systems.
6. Improve UI/UX.
7. Become native feature of WinCC OA installation !

## Author

Created by Aurélien Michon aka orelmi, 2025