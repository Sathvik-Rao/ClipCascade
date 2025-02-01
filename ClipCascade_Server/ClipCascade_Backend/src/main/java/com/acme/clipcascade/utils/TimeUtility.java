package com.acme.clipcascade.utils;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

public class TimeUtility {

    // Returns the current time in seconds since the Unix epoch
    public static long getCurrentTimeInSeconds() {
        return Instant.now().getEpochSecond();
    }

    // Returns the current time in milliseconds since the Unix epoch
    public static long getCurrentTimeInMilliseconds() {
        return System.currentTimeMillis();
    }

    // Resets time to the Unix epoch (1970-01-01T00:00:00Z)
    public static long resetTime() {
        return Instant.EPOCH.getEpochSecond();
    }

    // Converts seconds to days, hours, minutes, and seconds
    public static String convertSecondsToString(long seconds) {
        long days = seconds / (24 * 3600);
        seconds %= (24 * 3600);
        long hours = seconds / 3600;
        seconds %= 3600;
        long minutes = seconds / 60;
        seconds %= 60;

        return days + " days, " + hours + " hours, " + minutes + " minutes, " + seconds + " seconds";
    }

    public static String getCurrentDateTime() {
        return LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd_HH-mm-ss"));
    }
}
