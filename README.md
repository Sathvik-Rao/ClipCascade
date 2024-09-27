# <img src="https://github.com/user-attachments/assets/710bb1c3-0eda-48cf-819a-e066bde3a3ec" alt="ClipCascade Logo" width="34" /> ClipCascade

**ClipCascade** is an open-source, lightweight utility that automatically syncs your clipboard across multiple devices—no key press required. It ensures seamless clipboard sharing between devices, prioritizing privacy with end-to-end encryption. Whether you're moving between workstations or simply want the convenience of a unified clipboard, ClipCascade has you covered.

<div align="center">

<table>
  <tr>
    <th>Docker</th>
    <th>Windows</th>
    <th>Android</th>
    <th>Linux</th>
  </tr>
  <tr>
    <td>
      <a href="https://hub.docker.com/r/sathvikrao/clipcascade">
        <img src="https://www.docker.com/wp-content/uploads/2022/03/Moby-logo.png" alt="Docker" width="50" />
      </a>
    </td>
    <td>
      <a href="https://github.com/Sathvik-Rao/ClipCascade/releases">
        <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/5/5f/Windows_logo_-_2012.svg/512px-Windows_logo_-_2012.svg.png" alt="Windows" width="50" />
      </a>
    </td>
    <td>
      <a href="https://github.com/Sathvik-Rao/ClipCascade/releases">
        <img src="https://upload.wikimedia.org/wikipedia/commons/d/d7/Android_robot.svg" alt="Android" width="40" />
      </a>
    </td>
    <td>
      <a href="https://github.com/Sathvik-Rao/ClipCascade/releases">
        <img src="https://upload.wikimedia.org/wikipedia/commons/3/35/Tux.svg" alt="Linux" width="40" />
      </a>
    </td>
  </tr>
</table>

</div>

<br />

<div align="center">
<img src="https://github.com/user-attachments/assets/4dac30a0-2dda-49bb-a140-ee554a48c501" alt="Desktop Application" width="360" />
</div>


## 📸 Screenshots

| 🪟 Desktop (Windows) | 📱 Mobile (Android) | 🐧 Desktop (Linux) |
|-----------------------|--------------------|--------------------|
| <img src="https://github.com/user-attachments/assets/a73d18b9-ce0c-4a9e-9190-3a57a07596ce" alt="Desktop (Windows)" width="360" /> | <img src="https://github.com/user-attachments/assets/bde3a00a-14a6-4c58-bbd4-3b9a723e594f" alt="Mobile (Android)" width="360" /> | <img src="https://github.com/user-attachments/assets/66344289-470b-4183-af6a-cf47097388b8" alt="Desktop (Linux)" width="360" /> |
| <img src="https://github.com/user-attachments/assets/6f2830cc-c552-431e-98c5-dbe1c9d1882d" alt="Desktop (Windows)" width="240" /> | <img src="https://github.com/user-attachments/assets/2a4ba990-a51c-4e44-93e6-3eb0a81359b7" alt="Mobile (Android)" width="240" /> | <img src="https://github.com/user-attachments/assets/a2b941cc-f4df-4993-97d1-e4fe4721726e" alt="Desktop (Linux)" width="240" /> |

## ✨ Features

- **🔒 Secure Login Authentication:** Your data is safe. Login authentication ensures that only authorized users can access the clipboard sync.
- **🚀 Live Sync:** Clipboard content syncs across your devices instantly, without needing any key press—just copy, and it's there!
- **💻 Desktop Application:** A native desktop application for Windows and Linux, offering effortless setup and user-friendly operation.
- **📱 Mobile Application:** Access your clipboard sync seamlessly on Android devices with a dedicated mobile app.
- **📦 Self-Hosted Docker Image:** Host your own instance of ClipCascade effortlessly using the provided Docker image.
- **🛡️ Privacy by Encryption:** Your clipboard data is end-to-end encrypted, ensuring that only you can access it.
- **🌐 Web-Based Monitoring:** Monitor your clipboard activity in real-time via a sleek web interface.
- **⚙️ Advanced Settings:** Customize your clipboard sync experience with additional settings for fine-tuning performance.

## 📥 Installation

### 🦈 Self-Hosted Docker Server:

To host ClipCascade on your server, use Docker with the following steps:

1. Create a `docker-compose.yml` file with the following content:
   ```yaml
   version: '3.8'

   services:
     clipcascade:
       image: sathvikrao/clipcascade:0.1.0    #amd64
       # image: sathvikrao/clipcascade:0.1.0-multi-arch     #amd64, arm32v7, arm64v8, ppc64le, s390x
       ports:
         - "8080:8080"
       restart: always
       environment:
         - CC_USERNAME=user #username
         - CC_PASSWORD=pass123 #password
         - CC_MAX_MESSAGE_SIZE=1 #MiB (desktop(windows) < 25 MiB, mobile(android) ~ 1 MiB)
   ```
2. Run the Docker container using Docker Compose:
   ```
   docker-compose up -d
   ```
4. Access the web-based monitoring page at `http://localhost:8080`.


<img src="https://github.com/user-attachments/assets/489d1ffb-82fd-4dd8-85d6-445b891102a5" alt="Web Page" width="400" />
<img src="https://github.com/user-attachments/assets/5a52080e-0fd2-4e8b-b485-b41810174a86" alt="Web Page" width="400" />

### 🦾 Self-Hosted Server Bare Metal:

To host the ClipCascade server on any operating system where Java (17) can run, follow these steps:

1. **Download the JAR File**  
   Copy the `ClipCascade-0.0.1-SNAPSHOT.jar` from the [release page](https://github.com/Sathvik-Rao/ClipCascade/releases).

2. **Set Environment Variables**  
   Set the following environment variables in your OS:

   | Variable                      | Value              |
   |-------------------------------|--------------------|
   | `CC_USERNAME`                 | your-user-name     |
   | `CC_PASSWORD`                 | your-password      |
   | `CC_MAX_MESSAGE_SIZE`         | 1                  |

3. **Run the Server**  
   Execute the following command in your terminal:

   ```bash
   java -jar ClipCascade-0.0.1-SNAPSHOT.jar

4. **Access the Server**  
   You can access the ClipCascade server at `http://localhost:8080`.


### 🪟 Windows Desktop Application:

To install the Windows desktop application, download the latest version from the [Releases page](https://github.com/Sathvik-Rao/ClipCascade/releases).

1. **Download** the installer from the Releases page.
2. **Run** the installer and follow the on-screen instructions, and select the default installation path specified by the installer.
   - Startup is enabled by default; you can disable it in the Task Manager if desired.
3. **Launch** ClipCascade and log in to start syncing your clipboard across devices.
   - When prompted for the server connection, use the server IP and port, appending `/clipsocket` for the WebSocket connection (e.g., `ws://<server_ip>:<server_port>/clipsocket`).
   - If encryption is enabled, please ensure it is enabled on all devices.


**Important Note:** Since the application is not published or registered with Microsoft, you may see a warning suggesting that it could be unsafe. This is a standard precaution and does not indicate any issues with the software. You can choose to ignore this warning or temporarily disable your antivirus during installation. All source code is available in this repository, and everything is open source and free. If you prefer, you can compile the executable yourself. Feel free to review the code to ensure your comfort!

The .exe file does not need UAC approval because it is standalone executable, while the .msi installer will request UAC permissions because it creates a designated folder for the software, adds a startup option, and allows for uninstallation via the Control Panel. Additionally, with the .msi installer, you have the option to choose any location to save the software. However, select locations where even when you create a file manually at that location, Windows shouldn’t prompt for permission to answer "yes or no" questions.


### 🤖 Android Mobile Application:

To install the mobile application on your Android device, download the latest APK from the [Releases page](https://github.com/Sathvik-Rao/ClipCascade/releases).

1. **Download** the APK from the Releases page.
2. **Enable** installation from unknown sources in your device settings, if prompted.
3. **Install** the APK by following the prompts on your device.
4. **Open** ClipCascade and log in to begin syncing your clipboard across devices.
   - When prompted for the server connection, use the server IP and port, appending `/clipsocket` for the WebSocket connection (e.g., `ws://<server_ip>:<server_port>/clipsocket`).
   - If encryption is enabled, please ensure it is enabled on all devices.


### 🐧 Linux Desktop Application: 

This guide provides step-by-step instructions to install ClipCascade on Debian/Ubuntu and Fedora-based systems. While the commands are tailored for these distributions, the process can be adapted for other Linux distros with some tweaks. You can find the code for Linux in the [Releases page](https://github.com/Sathvik-Rao/ClipCascade/releases) as `ClipCascade_Linux.zip`. Navigate to the `ClipCascade/` folder, where you can find `main.py`, and open the terminal in that location.

#### Step 1: Update System and Install Required Packages

##### Debian/Ubuntu:
```
sudo apt update
sudo apt install -y python3 python3-pip python3-gi xclip
```

##### Fedora:
```
sudo dnf check-update
sudo dnf install -y python3 python3-pip python3-gobject xclip
```

#### Step 2: Install Python Dependencies

Run the following command to install the dependencies listed in `requirements.txt`:
```
sudo pip3 install -r requirements.txt
```

If you encounter the `error: externally-managed-environment`, install the required Python packages manually:

##### Debian/Ubuntu:
```
sudo apt install -y python3-xxhash python3-pyperclip python3-requests python3-websocket python3-pycryptodome python3-tk python3-pystray python3-plyer
```

##### Fedora:
```
sudo dnf install -y python3-xxhash python3-pyperclip python3-requests python3-websocket python3-pycryptodome python3-tkinter python3-pystray python3-plyer
```


#### Step 3: Install Gtk 3.0 for Clipboard Sharing

##### Debian/Ubuntu:
```
sudo apt install -y python3-gi-cairo gir1.2-gtk-3.0 gir1.2-gdk-3.0
```

##### Fedora:
```
sudo dnf install -y libappindicator-gtk3
```

> **Note:** If the tray icon is not available on GNOME-based systems like Fedora, you may need to install the GNOME tray support extension:
>  [GNOME AppIndicator Support](https://extensions.gnome.org/extension/615/appindicator-support/)


#### Step 4: Run the Application

Start ClipCascade by running:
```
sudo python3 main.py
```


#### Step 4.1: Fix 'No module named `Crypto`' Error (if applicable)

If you encounter the `No module named 'Crypto'` error, create a symbolic link for the Cryptodome library:
[see more](https://github.com/openthread/openthread/issues/1137#issuecomment-140879139)


##### Debian/Ubuntu:
```
sudo ln -s /usr/lib/python3/dist-packages/Cryptodome /usr/lib/python3/dist-packages/Crypto
```

##### Fedora:
```
sudo ln -s /usr/lib/python3/site-packages/Cryptodome /usr/lib/python3/site-packages/Crypto
```

#### Step 4.2: Fix 'ModuleNotFoundError: No module named `tkinter`' Error (if applicable)

If you encounter the `No module named 'tkinter'` error:

##### Debian/Ubuntu:
```
sudo apt install -y python3-tkinter
```

##### Fedora:
```
sudo dnf install -y python3-tkinter
```

#### Step 4.3:  Fix '`gtk_widget_get_scale_factor: assertion 'GTK_IS_WIDGET (widget)' failed`' Error (if applicable)

This error may be caused by a missing tray icon extension in GNOME. To fix it, you can install the AppIndicator Support extension by visiting [this link](https://extensions.gnome.org/extension/615/appindicator-support)



#### Step 5: Run the Application in the Background

To run ClipCascade as a background process:
```
sudo nohup python3 main.py &> /dev/null &
```


#### Step 6: Add ClipCascade to Startup

To ensure ClipCascade starts automatically when your system boots, modify the path as necessary and add the following to your startup script:

##### Example:
```
cd /path/to/clipcascade/src/ && sudo nohup python3 main.py &> /dev/null &
```


**Note:** If clipboard monitoring doesn't work without \`sudo\`, ensure you are running the application with elevated privileges.


## ⚙️ Advanced Details

### Windows and Linux:
- Logs are present in the installed path, allowing you to review application activity. These logs reset upon reopening the application, so they don’t grow indefinitely.
- You can customize advanced settings in the **DATA** file, which is also located in the installed path. This file is generated only after your first login and remains there indefinitely.

### Android:
- You can configure advanced settings on the login page by clicking **Enable Extra Config**. 
  - The main options include:
    - **Store Password Locally:** Enable this option if you are frequently getting logged out. The app stores the session cookie for an extended period, but due to the variety of devices used worldwide, exceptions may occur. This option can be very useful.
    - **Maximum Clipboard Size Local Limit:** If the app crashes or stops unexpectedly, it means it received a clipboard size greater than the platform's maximum limit. You can specify a local size limit by typing in the size in bytes (e.g., 512 KiB = 524288 bytes) to test different limits that work for your device. This local limit is in addition to the server-specified limit, ensuring smoother operation without crashes.

### End-to-End Encryption Configuration for Clipboard Data:

When encryption is enabled, the clipboard data is encrypted on client devices. The server does not store this key, ensuring end-to-end encryption. The encryption password is generated using the user’s password, a salt, and the number of rounds, allowing you to control the number of rounds used. This process creates a unique hashed password based on the specified number of rounds.

However, it is crucial to use the same number of rounds across all client devices. The default is set to **664,937** rounds, referred to as `hash_rounds`.

In the desktop application, you can find this field in the **DATA** file located in the software's directory. On mobile devices, you can adjust this setting in the login page under **extra config**.

Before making any changes, ensure you log out and exit the application. After editing the `hash_rounds` field, log back in for the changes to take effect.


## 🔧 Usage

1. **Login:** Use your credentials to log into ClipCascade.
2. **Sync:** Copy any text or content to your clipboard, and it will automatically sync across your connected devices.
3. **Monitor:** Open the web-based monitoring page to see your clipboard history in real-time.

## 🌍 Contributing

Contributions are welcome! Whether it's a feature request or a pull request, your input helps improve ClipCascade.

## 📜 License

ClipCascade is licensed under the GNU General Public License v3.0 (GPL-3.0). See the [LICENSE](https://github.com/Sathvik-Rao/ClipCascade/blob/main/LICENSE) file for more details.


## 🛠️ TODO

Here are some planned features and improvements for future releases of ClipCascade:

- **Windows Publishing:** Publish the Windows application to improve accessibility.
- **Android on Play Store:** Release the Android application on the Google Play Store for easier installation and updates.

## 💬 Support

If you encounter any issues or have questions, feel free to open an issue on GitHub or contact me via [email](mailto:sathvik.poladi@gmail.com).

