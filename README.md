# Project uploader Http Handler
A lightweight http handler for project uploading

## 🚀 Features

- web page allowing you to upload a ZIP file
- automatic decompression of ZIP in the project tree
- special file ``projupcmd`` allows to define the restart commands for WCCILpmon

## 🛠️ Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/orelmi/winccoa_logviewer.git
   ```
2. Copy files to project folder

3. Add Control Manager with options ```webclient_http.ctl```

## 📄 Usage

To use the log viewer:

1. Open URL https://localhost/logs/ in any modern browser (Chrome, Firefox, Edge).
2. The page displays the list of log files on the WinCC OA Server
3. Select a file
4. The page will automatically start fetching logs from the configured API.
	- Use the controls at the top of the page:
	- Pause scroll: Prevents auto-scrolling to the bottom.
	- Freeze updates: Temporarily stops fetching new logs.
	- Filter: Enter a keyword to show only matching log lines.
	- The background color changes based on the mode:
		- 🧊 Light blue when frozen
		- 🌕 Light yellow when scroll is paused
		
		
## 📸 Screenshots

Here are two screenshots showing the app in action:

The list of files
![Logs page](assets/page_logs.png)

The log viewer in action
![LogViewer page](assets/page_logviewer.png)

## Troubleshooting

### Common Issues

1. Only the last 1000 lines are displayed by default due to performance issue. Increasing this limit could cause load on the server and degrade the performances in production.


## Author

Created by Aurélien Michon, 2025