package com.acme.clipcascade.service;

import org.springframework.stereotype.Service;

import oshi.SystemInfo;
import oshi.hardware.HardwareAbstractionLayer;
import oshi.software.os.FileSystem;

@Service
public class SystemInfoService {

    private final SystemInfo systemInfo;
    private final HardwareAbstractionLayer hardware;
    private final FileSystem fileSystem;

    public SystemInfoService() {
        this.systemInfo = new SystemInfo();
        this.hardware = systemInfo.getHardware();
        this.fileSystem = systemInfo.getOperatingSystem().getFileSystem();
    }

    public long getAvailableRamInBytes() {

        return hardware.getMemory().getAvailable();
    }

    public long getAvailableDiskSpaceInBytes() {

        /*
         * get the first file system(usually the main file system) and return its usable
         * space
         */
        return fileSystem.getFileStores().get(0).getUsableSpace();
    }

    public long getMaxDirectMemoryInBytes() {

        /*
         * return the max direct memory available to the JVM. This is the maximum amount
         * of memory that can be allocated directly by the JVM. (-XX:MaxDirectMemorySize
         * or -Xmx)
         */
        return Runtime.getRuntime().maxMemory();
    }
}
