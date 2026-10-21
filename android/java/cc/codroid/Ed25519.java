package cc.codroid;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.util.Arrays;

/**
 * Ed25519 验签（RFC 8032 §5.1.7），只验不签。
 *
 * 系统自带的 Ed25519 要 Android 13（API 33）起才有，我们最低支持 8.0（API 26），所以自己写。
 * 用 BigInteger 直算，验一次几十毫秒，只用来核 modules.json 这类小清单的签名，够用。
 * 签名私钥和组件索引是同一把（files/bldtools/index-signing-ed25519.pem / 仓库 secret INDEX_SIGNING_KEY），
 * 公钥与网关里 COMP_INDEX_PUBKEY 相同。
 */
final class Ed25519 {
    private Ed25519() {}

    /** 签名公钥（32 字节原始公钥，base64）：与 gateway/gw/components.mjs 的 COMP_INDEX_PUBKEY 是同一把 */
    static final String INDEX_PUBKEY_B64 = "4u1V3UuRVZgXwqXXQaQIBaefPf2PCGqKqvsna9Pgzzs=";

    private static final BigInteger P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
    private static final BigInteger L = BigInteger.ONE.shiftLeft(252).add(new BigInteger("27742317777372353535851937790883648493"));
    private static final BigInteger D = BigInteger.valueOf(-121665).multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P);
    private static final BigInteger D2 = D.shiftLeft(1).mod(P);
    private static final BigInteger SQRT_M1 = BigInteger.valueOf(2).modPow(P.subtract(BigInteger.ONE).shiftRight(2), P);
    private static final BigInteger[] BASE;
    static {
        BigInteger by = BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P);
        BASE = point(recoverX(by, false), by);
    }

    /** 用内置公钥验 base64 签名；任何异常都算不通过 */
    static boolean verifyIndex(byte[] msg, String sigB64) {
        try {
            byte[] sig = android.util.Base64.decode(sigB64.trim(), android.util.Base64.DEFAULT);
            byte[] pub = android.util.Base64.decode(INDEX_PUBKEY_B64, android.util.Base64.DEFAULT);
            return verify(pub, msg, sig);
        } catch (Exception e) { return false; }
    }

    static boolean verify(byte[] pub, byte[] msg, byte[] sig) throws Exception {
        if (pub.length != 32 || sig.length != 64) return false;
        BigInteger[] a = decode(pub);
        byte[] rb = Arrays.copyOfRange(sig, 0, 32);
        BigInteger[] r = decode(rb);
        if (a == null || r == null) return false;
        BigInteger s = le(Arrays.copyOfRange(sig, 32, 64));
        if (s.compareTo(L) >= 0) return false;
        MessageDigest sha = MessageDigest.getInstance("SHA-512");
        sha.update(rb); sha.update(pub); sha.update(msg);
        BigInteger h = le(sha.digest()).mod(L);
        // [S]B == R + [h]A，按编码比
        return Arrays.equals(encode(mul(s, BASE)), encode(add(r, mul(h, a))));
    }

    private static BigInteger[] point(BigInteger x, BigInteger y) {
        return new BigInteger[] { x, y, BigInteger.ONE, x.multiply(y).mod(P) };
    }

    // 扩展坐标 (X, Y, Z, T) 下的点加（RFC 8032 §5.1.4）
    private static BigInteger[] add(BigInteger[] p, BigInteger[] q) {
        BigInteger a = p[1].subtract(p[0]).multiply(q[1].subtract(q[0])).mod(P);
        BigInteger b = p[1].add(p[0]).multiply(q[1].add(q[0])).mod(P);
        BigInteger c = p[3].multiply(D2).multiply(q[3]).mod(P);
        BigInteger d = p[2].shiftLeft(1).multiply(q[2]).mod(P);
        BigInteger e = b.subtract(a), f = d.subtract(c), g = d.add(c), h = b.add(a);
        return new BigInteger[] { e.multiply(f).mod(P), g.multiply(h).mod(P), f.multiply(g).mod(P), e.multiply(h).mod(P) };
    }

    private static BigInteger[] mul(BigInteger s, BigInteger[] p) {
        BigInteger[] q = { BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO };   // 单位元
        for (int i = s.bitLength() - 1; i >= 0; i--) {
            q = add(q, q);
            if (s.testBit(i)) q = add(q, p);
        }
        return q;
    }

    private static byte[] encode(BigInteger[] p) {
        BigInteger zi = p[2].modInverse(P);
        BigInteger x = p[0].multiply(zi).mod(P), y = p[1].multiply(zi).mod(P);
        byte[] out = new byte[32];
        byte[] be = y.toByteArray();
        for (int i = 0; i < be.length && i < 32; i++) out[i] = be[be.length - 1 - i];
        if (x.testBit(0)) out[31] |= (byte) 0x80;
        return out;
    }

    private static BigInteger[] decode(byte[] b) {
        byte[] c = b.clone();
        boolean sign = (c[31] & 0x80) != 0;
        c[31] &= 0x7f;
        BigInteger y = le(c);
        if (y.compareTo(P) >= 0) return null;
        BigInteger x = recoverX(y, sign);
        return x == null ? null : point(x, y);
    }

    private static BigInteger recoverX(BigInteger y, boolean sign) {
        BigInteger yy = y.multiply(y).mod(P);
        BigInteger x2 = yy.subtract(BigInteger.ONE).multiply(D.multiply(yy).add(BigInteger.ONE).modInverse(P)).mod(P);
        if (x2.signum() == 0) return sign ? null : BigInteger.ZERO;
        BigInteger x = x2.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P);
        if (!x.multiply(x).subtract(x2).mod(P).equals(BigInteger.ZERO)) x = x.multiply(SQRT_M1).mod(P);
        if (!x.multiply(x).subtract(x2).mod(P).equals(BigInteger.ZERO)) return null;
        if (x.testBit(0) != sign) x = P.subtract(x);
        return x;
    }

    /** 小端字节 → 非负整数 */
    private static BigInteger le(byte[] b) {
        byte[] be = new byte[b.length];
        for (int i = 0; i < b.length; i++) be[i] = b[b.length - 1 - i];
        return new BigInteger(1, be);
    }
}
