# <img src="https://github.com/user-attachments/assets/710bb1c3-0eda-48cf-819a-e066bde3a3ec" alt="ClipCascade Logo" width="34" /> ClipCascade

**ClipCascade** is an open-source, lightweight utility that automatically syncs your clipboard across multiple devices—no key press required. It ensures seamless clipboard sharing between devices, prioritizing privacy with end-to-end encryption. Whether you're moving between workstations or simply want the convenience of a unified clipboard, ClipCascade has you covered.

## 📸 Screenshots

**💻 Desktop Application:**

<img src="https://github.com/user-attachments/assets/a73d18b9-ce0c-4a9e-9190-3a57a07596ce" alt="Desktop Application" width="360" />
<img src="https://github.com/user-attachments/assets/6f2830cc-c552-431e-98c5-dbe1c9d1882d" alt="Desktop Application" width="240" />

**🌐 Web-Based Monitoring Page:**

<img src="https://github.com/user-attachments/assets/489d1ffb-82fd-4dd8-85d6-445b891102a5" alt="Web Page" width="400" />
<img src="https://github.com/user-attachments/assets/5a52080e-0fd2-4e8b-b485-b41810174a86" alt="Web Page" width="400" />


## ✨ Features

- **🔒 Secure Login Authentication:** Your data is safe. Login authentication ensures that only authorized users can access the clipboard sync.
- **🚀 Live Sync:** Clipboard content syncs across your devices instantly, without needing any key press—just copy, and it's there!
- **💻 Desktop Application:** A native Windows desktop application for easy setup and usage.
- **📦 Self-Hosted Docker Image:** Host your own instance of ClipCascade effortlessly using the provided Docker image.
- **🛡️ Privacy by Encryption:** Your clipboard data is end-to-end encrypted, ensuring that only you can access it.
- **🌐 Web-Based Monitoring:** Monitor your clipboard activity in real-time via a sleek web interface.

## 📥 Installation

### Self-Hosting with Docker

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
         - CC_MAX_MESSAGE_SIZE=3 #MiB (please keep the size under 30 MiB)
   ```
2. Run the Docker container using Docker Compose:
   ```
   docker-compose up -d
   ```
4. Access the web-based monitoring page at `http://localhost:8080`.


### Windows Desktop Application

To install the Windows desktop application, download the latest version from the [Releases page](https://github.com/Sathvik-Rao/ClipCascade/releases).

1. **Download** the installer from the link above.
2. **Run** the installer and follow the on-screen instructions.
3. **Launch** ClipCascade and log in to start syncing your clipboard across devices.

   
## 🔧 Usage

1. **Login:** Use your credentials to log into ClipCascade.
2. **Sync:** Copy any text or content to your clipboard, and it will automatically sync across your connected devices.
3. **Monitor:** Open the web-based monitoring page to keep track of your clipboard history in real-time.

## 🛡️ Privacy & Security

At ClipCascade, your privacy is a top priority. All clipboard data is encrypted before it leaves your device, ensuring that only you have access to it. The self-hosted option gives you full control over your data.

## 🌍 Contributing

Contributions are welcome! Whether it's a bug report, feature request, or a pull request, your input helps improve ClipCascade.

## 📜 License

ClipCascade is licensed under the GNU General Public License v3.0 (GPL-3.0). See the [LICENSE](https://github.com/Sathvik-Rao/ClipCascade/blob/main/LICENSE) file for more details.


## 🛠️ TODO

Here are some planned features and improvements for future releases of ClipCascade:

- **Mobile App:** Develop mobile applications for Android to extend clipboard sync capabilities.

## 💬 Support

If you encounter any issues or have questions, feel free to open an issue on GitHub or contact me via [email](mailto:sathvik.poladi@gmail.com).

