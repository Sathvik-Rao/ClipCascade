package com.clipcascade;

import com.clipcascade.IClipboardChangedCallback;

interface IClipboardUserService {
    String getPrimaryClipText() = 1;
    String getPrimaryClipMimeType() = 2;
    String getPrimaryClipUri() = 3;
    boolean setClipboardChangedCallback(IBinder callerToken, IClipboardChangedCallback callback) = 4;
    void clearClipboardChangedCallback(IBinder callerToken) = 5;
    boolean isClipboardServiceHealthy() = 6;
    void destroy() = 16777114;
}
