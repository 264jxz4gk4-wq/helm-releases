package org.harctoolbox.irp;
public final class Version {
    public final static String licenseString = "GPLv3+ (c) Bengt Martensson";
    public final static String thirdPartyString = "Antlr, StringTemplate (BSD), JCommander (Apache 2.0)";
    public final static String appName = "IrpTransmogrifier";
    public final static String version = "1.2.15-SNAPSHOT";
    public final static String commitId = "c945e7638355ca5697f458d33338ee1bfd4d1640";
    public final static String versionString = appName + " version " + version;
    public final static String homepageUrl = "https://www.harctoolbox.org";
    public final static String documentationUrl = homepageUrl + "/" + appName + ".html";
    public final static String currentVersionUrl = homepageUrl + "/downloads/" + appName + ".version";
    public static void main(String[] args) { System.out.println(versionString); }
    private Version() {}
}
