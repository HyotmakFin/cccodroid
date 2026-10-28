package cc.codroid;

import android.app.Activity;
import android.graphics.Rect;
import android.util.Log;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.List;

/** 折叠屏：经厂商随系统带的 androidx.window.extensions 拿折痕（不引 AndroidX，全反射）。
 *  清单里 uses-library 声明为可选；没有这个库、或厂商级别不认识，就当没有折痕，什么也不做。
 *  回调里只留最近一次的折痕（窗口坐标），由 MainActivity 换算成页面坐标交给网页。
 *  接口原文见 androidx window/extensions/.../layout/（WindowLayoutComponent、FoldingFeature）。 */
final class Fold {
    static final String TAG = "ccfold";

    interface Sink { void onFold(Fold f); }

    // 最近一次的折痕（三折叠展开时有两条）；没有就是空的。每条 = 窗口坐标的矩形 + 类型（1 折痕 / 2 铰链）+ 状态（1 展平 / 2 半开）
    static final class Feat { final Rect r; final int type, state; Feat(Rect r, int t, int s) { this.r = r; type = t; state = s; } }
    java.util.List<Feat> feats = new java.util.ArrayList<>();
    int vendor;      // 厂商接口级别，0 = 没有

    private final Activity act;
    private final Sink sink;
    private Object component, consumer;
    private Method remove;

    Fold(Activity act, Sink sink) { this.act = act; this.sink = sink; }

    void start() {
        try {
            Class<?> prov = Class.forName("androidx.window.extensions.WindowExtensionsProvider");
            Object ext = prov.getMethod("getWindowExtensions").invoke(null);
            vendor = (Integer) ext.getClass().getMethod("getVendorApiLevel").invoke(ext);
            component = ext.getClass().getMethod("getWindowLayoutComponent").invoke(ext);
            if (component == null) { Log.i(TAG, "vendor " + vendor + "，没有 WindowLayoutComponent"); return; }
            InvocationHandler h = new InvocationHandler() {
                @Override public Object invoke(Object p, Method m, Object[] a) {
                    String n = m.getName();
                    if (n.equals("accept") && a != null && a.length == 1) { take(a[0]); return null; }
                    if (n.equals("hashCode")) return System.identityHashCode(p);
                    if (n.equals("equals")) return a != null && p == a[0];
                    if (n.equals("toString")) return "ccfold-consumer";
                    return null;
                }
            };
            Class<?> cc = component.getClass();
            if (vendor >= 2) {
                // 2 起：Context + 扩展库自己的 Consumer（不受 Activity 限制，窗口上下文也行）
                Class<?> ci = Class.forName("androidx.window.extensions.core.util.function.Consumer");
                consumer = Proxy.newProxyInstance(ci.getClassLoader(), new Class<?>[]{ci}, h);
                cc.getMethod("addWindowLayoutInfoListener", android.content.Context.class, ci).invoke(component, act, consumer);
                remove = cc.getMethod("removeWindowLayoutInfoListener", ci);
            } else {
                Class<?> ci = java.util.function.Consumer.class;
                consumer = Proxy.newProxyInstance(ci.getClassLoader(), new Class<?>[]{ci}, h);
                cc.getMethod("addWindowLayoutInfoListener", Activity.class, ci).invoke(component, act, consumer);
                remove = cc.getMethod("removeWindowLayoutInfoListener", ci);
            }
            Log.i(TAG, "listening, vendor " + vendor);
        } catch (ClassNotFoundException e) {
            Log.i(TAG, "没有 window extensions：" + e.getMessage());
        } catch (Throwable e) {
            Log.w(TAG, "start failed (vendor " + vendor + ")", e);
        }
    }

    void stop() {
        try { if (remove != null && consumer != null) remove.invoke(component, consumer); }
        catch (Throwable e) { Log.w(TAG, "stop failed", e); }
        remove = null; consumer = null;
    }

    private void take(Object info) {
        final java.util.List<Feat> got = new java.util.ArrayList<>();
        StringBuilder log = new StringBuilder();
        try {
            List<?> all = (List<?>) info.getClass().getMethod("getDisplayFeatures").invoke(info);
            for (Object f : all) {
                Class<?> fc = f.getClass();
                Rect r = (Rect) fc.getMethod("getBounds").invoke(f);
                log.append(fc.getSimpleName()).append(' ').append(r.toShortString());
                Method gt;
                try { gt = fc.getMethod("getType"); } catch (NoSuchMethodException e) { continue; }   // 不是 FoldingFeature
                int ft = (Integer) gt.invoke(f), fs = (Integer) fc.getMethod("getState").invoke(f);
                log.append(" type=").append(ft).append(" state=").append(fs).append("; ");
                got.add(new Feat(r, ft, fs));
            }
        } catch (Throwable e) { Log.w(TAG, "parse failed", e); }
        java.util.Collections.sort(got, (a, b) -> a.r.left != b.r.left ? a.r.left - b.r.left : a.r.top - b.r.top);   // 从左到右、从上到下
        Log.i(TAG, "layout: " + (log.length() == 0 ? "(no features)" : log));
        act.runOnUiThread(new Runnable() { @Override public void run() {
            feats = got;
            sink.onFold(Fold.this);
        }});
    }
}
