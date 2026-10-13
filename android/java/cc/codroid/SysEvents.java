package cc.codroid;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 系统广播（导出，只认这两个动作）：
 *   MY_PACKAGE_REPLACED  自更新装完 → 把后台服务拉起来（系统替换时把我们整个杀了）
 *   BOOT_COMPLETED       开机 → 仅当用户开着"开机自动激活 Shizuku"且配对过，才启动服务去重新激活
 */
public class SysEvents extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        String a = i.getAction();
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            Installer.deleteTree(new java.io.File(c.getFilesDir(), "updates"));
            if (new Env(c).devkitReady()) GatewayService.start(c);
        } else if (Intent.ACTION_BOOT_COMPLETED.equals(a)) {
            ShizukuSetup s = ShizukuSetup.get(c);
            s.prefs().edit().putLong("bootSeen", System.currentTimeMillis()).apply();
            if (s.prefs().getBoolean("autostart", true) && s.prefs().getBoolean("paired", false) && s.hasWss() && new Env(c).devkitReady())
                c.startForegroundService(new Intent(c, GatewayService.class).setAction(GatewayService.ACTION_BOOT));
        }
    }
}
