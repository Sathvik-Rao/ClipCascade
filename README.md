# <img src="https://github.com/user-attachments/assets/710bb1c3-0eda-48cf-819a-e066bde3a3ec" alt="ClipCascade Logo" width="34" /> ClipCascade

**ClipCascade** is an open-source, lightweight utility that automatically syncs your clipboard across multiple devices—no key press required. It ensures seamless clipboard sharing between devices, prioritizing privacy with end-to-end encryption. Whether you're moving between workstations or simply want the convenience of a unified clipboard, ClipCascade has you covered.

<div align="center">
<img src="https://github.com/user-attachments/assets/4dac30a0-2dda-49bb-a140-ee554a48c501" alt="Desktop Application" width="360" />
</div>

## 📸 Screenshots

| 💻 Desktop (Windows) | 📱 Mobile (Android) |
|-----------------------|--------------------|
| <img src="https://github.com/user-attachments/assets/a73d18b9-ce0c-4a9e-9190-3a57a07596ce" alt="Desktop Application" width="360" /> | <img src="https://github.com/user-attachments/assets/bde3a00a-14a6-4c58-bbd4-3b9a723e594f" alt="Desktop Application" width="360" /> |
| <img src="https://github.com/user-attachments/assets/6f2830cc-c552-431e-98c5-dbe1c9d1882d" alt="Desktop Application" width="240" /> | <img src="https://github.com/user-attachments/assets/2a4ba990-a51c-4e44-93e6-3eb0a81359b7" alt="Desktop Application" width="240" /> |

## ✨ Features

- **🔒 Secure Login Authentication:** Your data is safe. Login authentication ensures that only authorized users can access the clipboard sync.
- **🚀 Live Sync:** Clipboard content syncs across your devices instantly, without needing any key press—just copy, and it's there!
- **💻 Desktop Application:** A native Windows desktop application for easy setup and usage.
- **📱 Mobile Application:** Access your clipboard sync seamlessly on Android devices with a dedicated mobile app.
- **📦 Self-Hosted Docker Image:** Host your own instance of ClipCascade effortlessly using the provided Docker image.
- **🛡️ Privacy by Encryption:** Your clipboard data is end-to-end encrypted, ensuring that only you can access it.
- **🌐 Web-Based Monitoring:** Monitor your clipboard activity in real-time via a sleek web interface.
- **⚙️ Advanced Settings:** Customize your clipboard sync experience with additional settings for fine-tuning performance.

## 📥 Installation

### 🦈 Self-Hosted Docker Server

To host ClipCascade on your server, use Docker with the following steps:

1. Create a `docker-compose.yml` file with the following content:
   ```yaml
   version: '3.8'

   services:
     clipcascade:
       image: sathvikrao/clipcascade:0.1.0
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


### 💻 Windows Desktop Application

To install the Windows desktop application, download the latest version from the [Releases page](https://github.com/Sathvik-Rao/ClipCascade/releases).

1. **Download** the installer from the Releases page.
2. **Run** the installer and follow the on-screen instructions, and select the default installation path specified by the installer.
   - Startup is enabled by default; you can disable it in the Task Manager if desired.
3. **Launch** ClipCascade and log in to start syncing your clipboard across devices.
   - When prompted for the server connection, use the server IP and port, appending `/clipsocket` for the WebSocket connection (e.g., `ws://<server_ip>:<server_port>/clipsocket`).


**Important Note:** Since the application is not published or registered with Microsoft, you may see a warning suggesting that it could be unsafe. This is a standard precaution and does not indicate any issues with the software. You can choose to ignore this warning or temporarily disable your antivirus during installation. All source code is available in this repository, and everything is open source and free. If you prefer, you can compile the executable yourself. Feel free to review the code to ensure your comfort!

### 📱 Android Mobile Application

To install the mobile application on your Android device, download the latest APK from the [Releases page](https://github.com/Sathvik-Rao/ClipCascade/releases).

1. **Download** the APK from the Releases page.
2. **Enable** installation from unknown sources in your device settings, if prompted.
3. **Install** the APK by following the prompts on your device.
4. **Open** ClipCascade and log in to begin syncing your clipboard across devices.
   - When prompted for the server connection, use the server IP and port, appending `/clipsocket` for the WebSocket connection (e.g., `ws://<server_ip>:<server_port>/clipsocket`).


## ⚙️ Advanced Details

### Windows
- Logs are present in the installed path, allowing you to review application activity. These logs reset upon reopening the application, so they don’t grow indefinitely.
- You can customize advanced settings in the **DATA** file, which is also located in the installed path. This file is generated only after your first login and remains there indefinitely.

### Android
- You can configure advanced settings on the login page by clicking **Enable Extra Config**. 
  - The main options include:
    - **Store Password Locally:** Enable this option if you are frequently getting logged out. The app stores the session cookie for an extended period, but due to the variety of devices used worldwide, exceptions may occur. This option can be very useful.
    - **Maximum Clipboard Size Local Limit:** If the app crashes or stops unexpectedly, it means it received a clipboard size greater than the platform's maximum limit. You can specify a local size limit by typing in the size in bytes (e.g., 512 KiB = 524288 bytes) to test different limits that work for your device. This local limit is in addition to the server-specified limit, ensuring smoother operation without crashes.


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

