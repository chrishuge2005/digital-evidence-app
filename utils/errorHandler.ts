export interface SafeError {
  message: string;
  isNetwork: boolean;
  isAuth: boolean;
  isPermission: boolean;
}

export const errorHandler = {
  handle(error: any): SafeError {
    const rawMsg = (error?.message || error?.error_description || String(error)).toLowerCase();

    // 1. Network Connectivity Errors
    if (rawMsg.includes('network') || rawMsg.includes('fetch failed') || rawMsg.includes('timeout') || rawMsg.includes('offline')) {
      return {
        message: 'Network connection error. Please check your internet connection.',
        isNetwork: true,
        isAuth: false,
        isPermission: false
      };
    }

    // 2. Authentication & Session Errors
    if (rawMsg.includes('jwt') || rawMsg.includes('token') || rawMsg.includes('401') || rawMsg.includes('auth_required') || rawMsg.includes('unauthorized')) {
      return {
        message: 'Your session has expired. Please log in again.',
        isNetwork: false,
        isAuth: true,
        isPermission: false
      };
    }

    // 3. Permission & RLS Errors
    if (rawMsg.includes('rls') || rawMsg.includes('policy') || rawMsg.includes('403') || rawMsg.includes('denied') || rawMsg.includes('permission')) {
      return {
        message: 'You do not have permission to perform this action.',
        isNetwork: false,
        isAuth: false,
        isPermission: true
      };
    }

    // 4. Default Safe Fallback (Hides SQL and internal implementation details)
    return {
      message: 'An unexpected error occurred. Please try again later.',
      isNetwork: false,
      isAuth: false,
      isPermission: false
    };
  }
};