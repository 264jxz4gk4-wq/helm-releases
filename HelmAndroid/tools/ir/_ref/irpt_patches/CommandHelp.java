package org.harctoolbox.cmdline;
// Local build stub: original uses JCommander >= 1.72 APIs not in the Ubuntu 1.71 jar. Help output only.
import com.beust.jcommander.JCommander;
import com.beust.jcommander.Parameters;
import java.io.PrintStream;
@Parameters(commandNames = {"help"}, commandDescription = "Describe the syntax of program and commands.")
public class CommandHelp extends AbstractCommand {
    public static void usage(PrintStream printStream, String command, JCommander argumentParser) {
        printStream.println("usage: (help stubbed in local build) command=" + command);
    }
    public void help(PrintStream out, AbstractCommand commonCommand, JCommander argumentParser, String url) {
        out.println("help stubbed in local build; see " + url);
    }
    @Override
    public String description() { return "help (stub)"; }
}
