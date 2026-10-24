// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Okidoki",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Okidoki", targets: ["Okidoki"]),
    ],
    targets: [
        .target(
            name: "OkidokiCore",
            path: "Sources/OkidokiCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "Okidoki",
            dependencies: ["OkidokiCore"],
            path: "Sources/Okidoki",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "OkidokiTests",
            dependencies: ["OkidokiCore"],
            path: "Tests/OkidokiTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
