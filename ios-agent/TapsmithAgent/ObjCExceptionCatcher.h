#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Catches Objective-C NSExceptions that bypass Swift's do/catch.
/// XCUITest private APIs can throw NSException which crashes the agent
/// if not caught at the ObjC level.
@interface ObjCExceptionCatcher : NSObject
+ (BOOL)tryBlock:(void(NS_NOESCAPE ^)(void))block error:(NSError *_Nullable *_Nullable)error;
@end

NS_ASSUME_NONNULL_END
