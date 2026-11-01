package com.clipcascade;

interface IPermissionGrantService {
    String grantPermissions(int userId) = 0;
    String forceStopApp(int userId) = 1;
    void destroy() = 16777114;
}
