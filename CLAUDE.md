# CLAUDE.md - WinCC OA Project Manager

This file provides guidance for AI assistants working with this codebase.

## Project Overview

This is a **WinCC OA Project Manager** - a lightweight HTTP-based web interface for managing WinCC Open Architecture projects. It enables remote deployment and management of WinCC OA projects through a web browser.

**Author:** Aurélien Michon (orelmi)
**License:** MIT
**Platform:** WinCC Open Architecture (SCADA system by Siemens)

## Key Features

- **Download Tab**: Upload ZIP files to deploy project updates remotely
- **Console Tab**: View WinCC OA manager status, restart project
- **Log Viewer Tab**: Coming soon (planned integration from winccoa_logviewer)

## Repository Structure

```
winccoa_projectuploader/
├── README.md                    # Project documentation
├── LICENSE                      # MIT License
├── CLAUDE.md                    # This file
├── assets/                      # Screenshot images for documentation
│   ├── consoleTab.png
│   ├── downloadTab.png
│   ├── main.png
│   ├── page_console.png
│   ├── page_projupload.png
│   └── page_para.png
└── winccoa_proj/                # WinCC OA project files to be copied
    ├── config/
    │   ├── config.env.bat              # Environment setup script
    │   └── AURELIEN-3581PC/            # Example hostname-specific config
    │       ├── install.bat             # Example dplist import command
    │       └── pmondeploy.example.txt  # Example pmon deploy commands
    ├── data/
    │   └── html/
    │       └── proj.html               # Main web interface (HTML/CSS/JS)
    ├── dplist/
    │   └── update_YYYYMMDD/           # Datapoint lists for import
    └── scripts/
        ├── webclient_http.ctl         # HTTP server entry point
        ├── projectdownload.ctl        # Project download/deployment handler
        └── libs/classes/
            ├── MyHttpServer.ctl       # Custom HTTP server class
            └── projectdownload/
                └── ProjectDownloadEndpoints.ctl  # HTTP endpoint handlers
```

## Technology Stack

### WinCC OA Control Language (CTL)
- This project uses **CTL** (Control Language), a proprietary scripting language for WinCC OA
- CTL files have `.ctl` extension and are similar to C/C++ syntax
- Key libraries used: `CtrlHTTP`, `pmon`, `compression`, `CtrlPv2Admin`, `CtrlXml`

### Web Frontend
- Pure HTML/CSS/JavaScript (no frameworks)
- Single-page application with tab-based navigation
- Uses Fetch API for async HTTP requests

## Architecture

### Control Managers

1. **webclient_http.ctl**
   - Entry point for HTTP server
   - Instantiates `MyHttpServer` class
   - Sets max content length to 100MB

2. **projectdownload.ctl**
   - Handles project deployment operations
   - Creates datapoint type `PROJECT_DOWNLOAD` with elements:
     - `filedata` (BLOB): ZIP file data
     - `status` (INT): Operation status
     - `command` (BOOL): Trigger flag
     - `restartproj` (BOOL): Restart after deploy flag
     - `pmon` (STRING): JSON pmon data
   - Monitors pmon status every second
   - Executes post-deploy scripts (config.env.bat, install.bat, pmondeploy.txt)

### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/project` | GET | Main web interface |
| `/project/download` | POST | Upload ZIP file for deployment |
| `/project/restart` | POST | Restart all managers |
| `/project/pmon` | GET | Get pmon status as JSON |

### Configuration

Enable the interface in WinCC OA config file:
```ini
[httpProjectDownload]
enabled = true
```

## Key Conventions

### CTL Coding Style
- Class files use PascalCase (e.g., `MyHttpServer.ctl`)
- Constants use UPPER_SNAKE_CASE (e.g., `DPT_PROJDOWN`)
- Functions use camelCase (e.g., `refreshPmon`, `configEnv`)
- Use `#uses` directive for imports at file start
- Debug output via `DebugTN()` function

### File Naming
- CTL scripts: lowercase with underscores (e.g., `webclient_http.ctl`)
- Class files: PascalCase matching class name
- Config files by hostname: Use FQDN or NetBIOS name as folder name

### Datapoint Conventions
- Datapoint type: `PROJECT_DOWNLOAD` (constant)
- Datapoint names: Configurable via command line argument (default: `PROJECT_DOWNLOAD_001`)
- Multiple DPs supported for distributed systems

## Development Workflow

### Installation
1. Copy `winccoa_proj/` contents to target WinCC OA project
2. Add Control Manager: `webclient_http.ctl`
3. Add Control Manager: `projectdownload.ctl PROJ_SRV_A -num 98`
4. For remote projects, use different DP names and manager numbers

### Deployment Flow
1. User uploads ZIP file via web interface
2. ZIP data stored in `filedata` DPE (datapoint element)
3. `projectdownload.ctl` detects change via `dpConnect`
4. ZIP extracted to project path
5. Post-deploy scripts executed in order:
   - `config.env.bat` - Copy hostname-specific config files
   - `install.bat` - Import dplist files (auto-deleted after)
   - `pmondeploy.txt` - Execute pmon commands (auto-deleted after)
6. Optional project restart if requested

### Special Deploy Files

**config.env.bat**: Automatically copies files from hostname-specific subfolder
- Looks for folder matching FQDN first, then NetBIOS name
- Supports progs, config, and other project files

**install.bat**: Contains WinCC OA ASCII import commands
```bat
WCCOAasciiSQLite -currentproj -in dplist/update_YYYYMMDD/*.dpl
```

**pmondeploy.txt**: Contains pmon commands
```
##SINGLE_MGR:STOP 6      # Stop manager at index 6
##RESTART_ALL:           # Restart all managers
```

## Security Considerations

**WARNING: This interface is NOT secured for production use!**

Current limitations:
- No authentication on web form
- No HTTPS certificate validation
- Direct system command execution
- ZIP files extracted with full permissions

The roadmap includes adding pmon authentication for security.

## Testing

No automated test suite exists. Manual testing:
1. Access `https://localhost/project` in browser
2. Verify Download tab shows file upload form
3. Verify Console tab shows manager status
4. Test ZIP upload and extraction
5. Test project restart functionality

## Common Issues

1. **Interface returns 404**: Check `[httpProjectDownload] enabled = true` in config
2. **ZIP extraction fails**: Verify file permissions and disk space
3. **Manager restart fails**: Check pmon port and connectivity
4. **Database updates fail**: Database locked - see limitations in README

## Related Projects

- [winccoa_logviewer](https://github.com/orelmi/winccoa_logviewer) - Log viewer (planned integration)

## Roadmap

1. Download from Gedi (menu extension)
2. Database keep/replace options
3. Pmon authentication
4. Redundancy support
5. Distributed systems support
6. UI/UX improvements
7. Native WinCC OA feature integration
