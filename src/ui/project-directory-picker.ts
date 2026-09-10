import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

// IFileOpenDialog is the same modern Explorer-style picker used by desktop editors.
// It supports the normal address bar, navigation pane and recent locations.
export const windowsFolderPickerScript = String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$source = @'
using System;
using System.Runtime.InteropServices;

namespace ProviderDock {
  [Flags]
  public enum FOS : uint {
    PICKFOLDERS = 0x00000020,
    FORCEFILESYSTEM = 0x00000040,
    NOCHANGEDIR = 0x00000008,
    PATHMUSTEXIST = 0x00000800
  }

  public enum SIGDN : uint { FILESYSPATH = 0x80058000 }

  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
  internal class FileOpenDialogCom { }

  [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(FOS options);
    void GetOptions(out FOS options);
    void SetDefaultFolder(IShellItem folder);
    void SetFolder(IShellItem folder);
    void GetFolder(out IShellItem folder);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, uint placement);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
    void GetResults(out IntPtr items);
    void GetSelectedItems(out IntPtr items);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(SIGDN kind, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
  }

  public static class NativeFolderPicker {
    public static string Pick(IntPtr ownerHandle) {
      IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogCom();
      IShellItem item = null;
      try {
        FOS options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | FOS.PICKFOLDERS | FOS.FORCEFILESYSTEM | FOS.NOCHANGEDIR | FOS.PATHMUSTEXIST);
        dialog.SetTitle("Выберите папку проекта");
        dialog.SetOkButtonLabel("Выбрать папку");
        int result = dialog.Show(ownerHandle);
        if (result == unchecked((int)0x800704C7)) return null;
        Marshal.ThrowExceptionForHR(result);
        dialog.GetResult(out item);
        IntPtr path;
        item.GetDisplayName(SIGDN.FILESYSPATH, out path);
        try { return Marshal.PtrToStringUni(path); }
        finally { Marshal.FreeCoTaskMem(path); }
      }
      finally {
        if (item != null) Marshal.FinalReleaseComObject(item);
        Marshal.FinalReleaseComObject(dialog);
      }
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Opacity = 0
try {
  $owner.Show()
  $owner.Activate()
  $selected = [ProviderDock.NativeFolderPicker]::Pick($owner.Handle)
  if ($selected) { [Console]::Out.Write($selected) }
}
finally {
  $owner.Close()
  $owner.Dispose()
}
`;

/** Opens the native Windows folder chooser and returns only a real filesystem path. */
export async function pickProjectDirectory(): Promise<string | undefined> {
  if (process.platform !== "win32") {
    throw new Error("Выбор папки кнопкой сейчас поддерживается только в Windows.");
  }

  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-STA", "-NonInteractive", "-Command", windowsFolderPickerScript],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5 * 60_000,
        maxBuffer: 64 * 1024,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

  const selected = output.trim();
  if (!selected) return undefined;
  if (!isAbsolute(selected)) {
    throw new Error("Выбранный объект не является папкой файловой системы.");
  }
  const normalized = normalize(selected);
  const metadata = await stat(normalized);
  if (!metadata.isDirectory()) throw new Error("Выбранный путь не является папкой.");
  return normalized;
}
