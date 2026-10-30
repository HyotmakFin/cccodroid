package cc.codroid;

import java.math.BigInteger;

/** 自实现 Ed25519 验签的回归（审查 10-30 第九份 存疑1）：它是工具包清单的唯一信任锚。
 *  RFC 8032 第 7.1 节 TEST 1–3 必须过；改一位消息 / 签名、换公钥、S 不规范（S + L）必须拒。
 *  跑法：sh scripts/java-tests.sh */
public class Ed25519Vectors {
    static byte[] hex(String s) {
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }
    static int fails = 0;
    static void check(String name, boolean got, boolean want) {
        System.out.println((got == want ? "PASS " : "FAIL ") + name);
        if (got != want) fails++;
    }
    static boolean v(byte[] pk, byte[] m, byte[] s) { try { return Ed25519.verify(pk, m, s); } catch (Exception e) { return false; } }

    public static void main(String[] a) {
        String[][] T = {
            { "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
              "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b" },
            { "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
              "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00" },
            { "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
              "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a" },
        };
        for (int i = 0; i < T.length; i++) {
            byte[] pk = hex(T[i][0]), m = hex(T[i][1]), s = hex(T[i][2]);
            check("RFC 8032 TEST " + (i + 1), v(pk, m, s), true);
            byte[] s2 = s.clone(); s2[5] ^= 1;
            check("TEST " + (i + 1) + " 签名改一位", v(pk, m, s2), false);
            byte[] s3 = s.clone(); s3[40] ^= 0x10;
            check("TEST " + (i + 1) + " S 改一位", v(pk, m, s3), false);
            byte[] m2 = java.util.Arrays.copyOf(m, m.length + 1);
            check("TEST " + (i + 1) + " 消息多一个字节", v(pk, m2, s), false);
            check("TEST " + (i + 1) + " 换公钥", v(hex(T[(i + 1) % T.length][0]), m, s), false);
            // S + L：数学上同一个签名，规范要求拒（不拒就有签名可塑性）
            BigInteger L = BigInteger.ONE.shiftLeft(252).add(new BigInteger("27742317777372353535851937790883648493"));
            byte[] sl = new byte[32];
            for (int k = 0; k < 32; k++) sl[k] = s[63 - k];
            BigInteger S = new BigInteger(1, sl).add(L);
            byte[] be = S.toByteArray(), le = new byte[32];
            for (int k = 0; k < 32 && k < be.length; k++) le[k] = be[be.length - 1 - k];
            byte[] s4 = s.clone(); System.arraycopy(le, 0, s4, 32, 32);
            if (S.bitLength() <= 256) check("TEST " + (i + 1) + " S+L 不规范", v(pk, m, s4), false);
        }
        check("长度不对的签名", v(hex(T[0][0]), new byte[0], new byte[63]), false);
        check("全零公钥", v(new byte[32], new byte[0], hex(T[0][2])), false);
        check("工具包公钥 + 乱签名", Ed25519.verifyIndex("x".getBytes(), java.util.Base64.getEncoder().encodeToString(new byte[64])), false);
        System.out.println(fails == 0 ? "OK" : fails + " 项失败");
        System.exit(fails == 0 ? 0 : 1);
    }
}
