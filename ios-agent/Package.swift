// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "PilotAgent",
    platforms: [
        .iOS(.v15),
    ],
    products: [],
    targets: [
        // The iOS agent is built as an XCUITest bundle, not a regular Swift package.
        // This Package.swift exists for syntax checking and editor support only.
        // The actual build uses xcodebuild with the Xcode project.
        //
        // To build:
        //   xcodebuild build-for-testing \
        //     -project PilotAgent.xcodeproj \
        //     -scheme PilotAgent \
        //     -destination 'platform=iOS Simulator,name=iPhone 16'
    ]
)
