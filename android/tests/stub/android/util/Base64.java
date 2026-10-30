package android.util;
// 测试桩：只给 Ed25519.java 编译用（真机上是系统的 android.util.Base64）
public final class Base64 {
    public static final int DEFAULT = 0;
    public static byte[] decode(String s, int flags) { return java.util.Base64.getMimeDecoder().decode(s); }
}
