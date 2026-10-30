import Foundation

/// The connectors okidoki ships with: Calendar, Apify and your MCP servers.
public enum Connectors {
    public static let defaults: [Connector] = [
        Connector(id: "calendar", name: "Apple Calendar", kind: "apple",
                  blurb: "Read today's events and move things around without opening Calendar.",
                  installCommand: "osascript -l JavaScript -e 'Application(\"Calendar\").name()'",
                  docs: "Use Calendar.app via JXA. Never create an event without confirming date, time and title."),
        // On by default when the build ships an Apify key; otherwise it stays off until one is added in Settings › Keys.
        Connector(id: "apify", name: "Apify", kind: "cloud",
                  blurb: "Live web data: Google, LinkedIn, Instagram, TikTok, X, YouTube, Reddit, Amazon, Maps, Airbnb, Zillow and any site's text.",
                  enabled: !ServiceSecrets.apify.isEmpty, installed: !ServiceSecrets.apify.isEmpty,
                  installCommand: "",
                  docs: "Uses the Apify key the build ships (APIFY_API_KEY), or one added in Settings › Keys. Runs actors through the brain's connector kind; always preview first, since actors cost credits."),
        Connector(id: "mcp", name: "MCP servers", kind: "mcp",
                  blurb: "Bring your existing model-context tools into Okidoki runs.",
                  installCommand: "",
                  docs: "Add servers in Settings › MCP servers; their secrets stay on the Mac. Always show which server a tool belongs to."),
    ]
}
