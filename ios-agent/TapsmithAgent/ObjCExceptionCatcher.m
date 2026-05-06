#import "ObjCExceptionCatcher.h"

@implementation ObjCExceptionCatcher

+ (nullable NSError *)catchExceptionInBlock:(void(NS_NOESCAPE ^)(void))block {
    @try {
        block();
        return nil;
    } @catch (NSException *exception) {
        return [NSError errorWithDomain:@"dev.tapsmith.agent"
                                   code:-1
                               userInfo:@{
            NSLocalizedDescriptionKey: exception.reason ?: exception.name
        }];
    }
}

@end
