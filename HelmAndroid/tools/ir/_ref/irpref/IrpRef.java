// Batch driver around IrpTransmogrifier (GPLv3, Bengt Martensson) used only as a test reference.
// render mode: stdin lines "ProtocolName|D=1,S=2,F=3"  or  "irp:{...IRP...}|D=..,F=.."
//   -> one JSON line per input: {"f":hz,"intro":[...],"rep":[...],"end":[...]} (µs, unsigned) or {"err":"..."}
// decode mode: stdin lines "freq|d1 d2 d3 ..." (mark first) -> decodes (non-strict, all decodes)
import java.io.*;
import java.util.*;
import org.harctoolbox.irp.*;
import org.harctoolbox.ircore.*;
public class IrpRef {
    static String arr(IrSequence s) {
        StringBuilder sb = new StringBuilder("[");
        if (s != null) for (int i = 0; i < s.getLength(); i++) { if (i > 0) sb.append(','); sb.append(Math.abs(s.get(i))); }
        return sb.append(']').toString();
    }
    static String esc(String s) { return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "'").replace("\n", " "); }
    public static void main(String[] args) throws Exception {
        boolean dec = args.length > 0 && args[0].equals("decode");
        IrpDatabase db = IrpDatabase.newDefaultIrpDatabase();
        Decoder decoder = dec ? new Decoder(db) : null;
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        String line;
        Map<String, Protocol> cache = new HashMap<>();
        while ((line = in.readLine()) != null) {
            line = line.trim(); if (line.isEmpty()) continue;
            int bar = line.lastIndexOf('|');
            String head = line.substring(0, bar), tail = line.substring(bar + 1);
            try {
                if (!dec) {
                    Protocol p = cache.get(head);
                    if (p == null) { p = head.startsWith("irp:") ? new Protocol(head.substring(4)) : db.getProtocolExpandAlias(head); cache.put(head, p); }
                    Map<String, Long> params = new LinkedHashMap<>();
                    for (String kv : tail.split(",")) { if (kv.isEmpty()) continue; String[] a = kv.split("="); params.put(a[0].trim(), Long.parseLong(a[1].trim())); }
                    IrSignal sig = p.toIrSignal(params);
                    out.println("{\"f\":" + sig.getFrequencyWithDefault() + ",\"dc\":" + sig.getDutyCycle() + ",\"intro\":" + arr(sig.getIntroSequence()) + ",\"rep\":" + arr(sig.getRepeatSequence()) + ",\"end\":" + arr(sig.getEndingSequence()) + "}");
                } else {
                    double f = Double.parseDouble(head);
                    String[] t = tail.trim().split("\\s+");
                    double[] d = new double[t.length + (t.length % 2)];
                    for (int i = 0; i < t.length; i++) d[i] = Double.parseDouble(t[i]);
                    if (t.length % 2 == 1) d[t.length] = 100000;
                    ModulatedIrSequence seq = new ModulatedIrSequence(d, f);
                    Decoder.DecoderParameters dp = new Decoder.DecoderParameters();
                    dp.setStrict(false); dp.setAllDecodes(true); dp.setFrequencyTolerance(-1.0); dp.setRemoveDefaultedParameters(true);
                    Decoder.DecodeTree tree = decoder.decode(seq, dp);
                    out.println(esc(tree.toString()));
                }
            } catch (Exception ex) {
                out.println("{\"err\":\"" + esc(ex.getClass().getSimpleName() + ": " + ex.getMessage()) + "\"}");
            }
        }
    }
}
