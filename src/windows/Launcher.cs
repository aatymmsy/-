// Build with the Windows .NET Framework compiler. Source is shipped with the launcher.
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher {
  const string AppId = "Perch.Desktop";
  static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr extra);
  delegate bool EnumProc(IntPtr window, IntPtr extra);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr module, string path, uint type, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref Variant value);
  [StructLayout(LayoutKind.Sequential, Pack=4)] struct Key { public Guid format; public uint id; public Key(uint n) { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); id = n; } }
  [StructLayout(LayoutKind.Explicit, Size=24)] struct Variant { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr pointer; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    uint GetCount(); void GetAt(uint index, out Key key); void GetValue(ref Key key, out Variant value);
    void SetValue(ref Key key, ref Variant value); void Commit();
  }
  static void SetProperty(IPropertyStore store, uint property, string text) {
    Key key = new Key(property); Variant value = new Variant { type=31, pointer=Marshal.StringToCoTaskMemUni(text) };
    try { store.SetValue(ref key, ref value); } finally { PropVariantClear(ref value); }
  }
  static void Shortcuts() {
    Type type = Type.GetTypeFromProgID("WScript.Shell"); if (type == null) return;
    dynamic shell = Activator.CreateInstance(type);
    foreach (string folder in new [] { Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs") }) {
      dynamic link = shell.CreateShortcut(Path.Combine(folder, "栖 · Perch.lnk"));
      link.TargetPath = Path.Combine(Root, "栖.exe"); link.WorkingDirectory = Root;
      link.IconLocation = Path.Combine(Root, "public", "icon.ico") + ",0";
      link.Description = "栖 · 聊天、日记、记忆与文件"; link.Save(); Marshal.FinalReleaseComObject(link);
    }
    Marshal.FinalReleaseComObject(shell);
  }
  static void Decorate() {
    IntPtr found = IntPtr.Zero;
    for (int attempt=0; attempt<60 && found == IntPtr.Zero; attempt++) {
      EnumWindows(delegate(IntPtr window, IntPtr unused) {
        StringBuilder title = new StringBuilder(512); GetWindowText(window,title,title.Capacity);
        if (IsWindowVisible(window) && title.ToString().StartsWith("栖 · Perch")) { found=window; return false; }
        return true;
      },IntPtr.Zero);
      if (found == IntPtr.Zero) Thread.Sleep(500);
    }
    if (found == IntPtr.Zero) return;
    string icon = Path.Combine(Root,"public","icon.ico");
    IntPtr big = LoadImage(IntPtr.Zero,icon,1,256,256,0x10), small = LoadImage(IntPtr.Zero,icon,1,32,32,0x10);
    SendMessage(found,0x80,new IntPtr(1),big); SendMessage(found,0x80,IntPtr.Zero,small);
    try {
      Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); IPropertyStore store;
      if (SHGetPropertyStoreForWindow(found,ref iid,out store) == 0) {
        SetProperty(store,2,"\"" + Path.Combine(Root,"栖.exe") + "\""); SetProperty(store,3,icon+",0"); SetProperty(store,4,"栖 · Perch"); SetProperty(store,5,AppId); store.Commit(); Marshal.FinalReleaseComObject(store);
      }
    } catch { /* WM_SETICON and shortcut icons still work on older Windows. */ }
    Directory.CreateDirectory(Path.Combine(Root,"data"));
    File.WriteAllText(Path.Combine(Root,"data","icon-window.json"),"{\"windowFound\":true,\"largeIcon\":"+(big!=IntPtr.Zero?"true":"false")+",\"smallIcon\":"+(small!=IntPtr.Zero?"true":"false")+"}");
    // Keep ownership of the HICONs while the app window exists.
    while (IsWindow(found)) Thread.Sleep(2000);
  }
  [STAThread] static void Main(string[] args) {
    SetCurrentProcessExplicitAppUserModelID(AppId);
    if (args.Length>0 && args[0]=="--decorate") { Decorate(); return; }
    try {
      Shortcuts();
      Process.Start(new ProcessStartInfo("node", "src/launch.mjs") { WorkingDirectory=Root, UseShellExecute=true });
    } catch (Exception error) { MessageBox.Show("启动失败，请确认已安装 Node.js 24。\n"+error.Message,"栖"); }
  }
}
