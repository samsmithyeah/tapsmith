#import "ObjCExceptionCatcher.h"

@implementation ObjCExceptionCatcher

+ (BOOL)tryBlock:(void(NS_NOESCAPE ^)(void))block error:(NSError **)error {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (error) {
            *error = [NSError errorWithDomain:@"dev.tapsmith.agent"
                                         code:-1
                                     userInfo:@{
                NSLocalizedDescriptionKey: exception.reason ?: exception.name
            }];
        }
        return NO;
    }
}

@end
