import ctypes
import os
from ctypes import wintypes
from pathlib import Path


_TH32CS_SNAPPROCESS = 0x00000002
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_PROCESS_TERMINATE = 0x0001
_SYNCHRONIZE = 0x00100000
_WAIT_OBJECT_0 = 0
_WAIT_TIMEOUT = 0x00000102
_WM_CLOSE = 0x0010
_MAX_PATH = 260


class _ProcessEntry32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * _MAX_PATH),
    ]


def _kernel32():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32FirstW.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_ProcessEntry32W),
    ]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_ProcessEntry32W),
    ]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [
        wintypes.DWORD,
        wintypes.BOOL,
        wintypes.DWORD,
    ]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.TerminateProcess.restype = wintypes.BOOL
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    return kernel32


def _normalized_path(path):
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def _process_path(kernel32, process_id):
    process = kernel32.OpenProcess(
        _PROCESS_QUERY_LIMITED_INFORMATION, False, process_id
    )
    if not process:
        return None

    try:
        buffer = ctypes.create_unicode_buffer(_MAX_PATH)
        size = wintypes.DWORD(len(buffer))
        if not kernel32.QueryFullProcessImageNameW(process, 0, buffer, ctypes.byref(size)):
            return None
        return _normalized_path(buffer.value)
    finally:
        kernel32.CloseHandle(process)


def terminal_process_ids(terminal_path):
    """Return PIDs for this exact terminal executable on Windows."""
    if os.name != "nt":
        return set()

    kernel32 = _kernel32()
    snapshot = kernel32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
    if snapshot == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())

    expected_path = _normalized_path(terminal_path)
    process_ids = set()
    try:
        entry = _ProcessEntry32W()
        entry.dwSize = ctypes.sizeof(entry)
        if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            raise ctypes.WinError(ctypes.get_last_error())

        while True:
            if entry.szExeFile.casefold() == Path(terminal_path).name.casefold():
                process_id = int(entry.th32ProcessID)
                if _process_path(kernel32, process_id) == expected_path:
                    process_ids.add(process_id)
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                error = ctypes.get_last_error()
                if error != 18:
                    raise ctypes.WinError(error)
                break
    finally:
        kernel32.CloseHandle(snapshot)

    return process_ids


def _request_window_close(process_id):
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    enum_windows_proc = ctypes.WINFUNCTYPE(
        wintypes.BOOL, wintypes.HWND, wintypes.LPARAM
    )
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.GetWindowThreadProcessId.argtypes = [
        wintypes.HWND,
        ctypes.POINTER(wintypes.DWORD),
    ]
    user32.PostMessageW.restype = wintypes.BOOL
    user32.PostMessageW.argtypes = [
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.EnumWindows.argtypes = [enum_windows_proc, wintypes.LPARAM]

    def close_matching_window(window, _):
        window_process_id = wintypes.DWORD()
        user32.GetWindowThreadProcessId(window, ctypes.byref(window_process_id))
        if window_process_id.value == process_id:
            user32.PostMessageW(window, _WM_CLOSE, 0, 0)
        return True

    callback = enum_windows_proc(close_matching_window)
    user32.EnumWindows(callback, 0)


def close_owned_terminal_processes(terminal_path, process_ids):
    """Close only terminal processes recorded as started by this backend."""
    if os.name != "nt":
        return

    kernel32 = _kernel32()

    for process_id in set(process_ids):
        if _process_path(kernel32, process_id) != _normalized_path(terminal_path):
            continue

        _request_window_close(process_id)
        process = kernel32.OpenProcess(
            _SYNCHRONIZE | _PROCESS_TERMINATE, False, process_id
        )
        if not process:
            error = ctypes.get_last_error()
            if error == 87:
                continue
            raise ctypes.WinError(error)

        try:
            result = kernel32.WaitForSingleObject(process, 10_000)
            if result == _WAIT_TIMEOUT:
                if not kernel32.TerminateProcess(process, 1):
                    raise ctypes.WinError(ctypes.get_last_error())
                result = kernel32.WaitForSingleObject(process, 5_000)
            if result != _WAIT_OBJECT_0:
                if result == _WAIT_TIMEOUT:
                    raise TimeoutError(f"MT5 terminal PID {process_id} did not exit")
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            kernel32.CloseHandle(process)
