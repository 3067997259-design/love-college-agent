// Independent implementation of the documented Win32 AppContainer and Job Object APIs.
// Sources and acceptance boundary: docs/engineering/desk-command-sandbox.md.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class DeskCommand {
    static string stage="input";
    [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI {
        public int cb; public string reserved, desktop, title; public int x,y,width,height,charsX,charsY,fill,flags;
        public short show,reservedCount; public IntPtr reservedData,stdin,stdout,stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct SX { public SI si; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int processId,threadId; }
    [StructLayout(LayoutKind.Sequential)] struct Caps { public IntPtr sid, capabilities; public uint count,reserved; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong read,write,other,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,uint revision,out IntPtr descriptor,out uint size);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr sacl,out bool defaulted);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string name,uint type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int info,IntPtr buffer,int length,out int needed);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSa,IntPtr threadSa,bool inherit,uint flags,IntPtr environment,string cwd,ref SX startup,out PI process);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr info,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA attributes,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,ref SA attributes,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

    static void Need(bool condition) { if (!condition) throw new InvalidOperationException("win32-" + Marshal.GetLastWin32Error()); }
    static IntPtr Value<T>(T value) where T:struct { IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T))); Marshal.StructureToPtr(value,p,false); return p; }
    static void Free(ref IntPtr p) { if(p!=IntPtr.Zero){Marshal.FreeHGlobal(p);p=IntPtr.Zero;} }
    static void Close(ref IntPtr p) { if(p!=IntPtr.Zero && p!=new IntPtr(-1))CloseHandle(p);p=IntPtr.Zero; }
    static void LowLabel(string path) {
        IntPtr descriptor=IntPtr.Zero; uint size; bool present,def; IntPtr sacl;
        try { stage="label-descriptor"; Need(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)",1,out descriptor,out size)); stage="label-sacl"; Need(GetSecurityDescriptorSacl(descriptor,out present,out sacl,out def) && present); stage="label-apply"; uint code=SetNamedSecurityInfo(path,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl);if(code!=0)throw new InvalidOperationException("win32-"+code.ToString()); }
        finally { if(descriptor!=IntPtr.Zero)LocalFree(descriptor); }
    }
    // Only a disposable snapshot is ever granted access; never change the real desk or private-profile ACLs.
    static void Grant(string root,SecurityIdentifier sid) {
        foreach(string entry in Directory.GetFileSystemEntries(root)) {
            FileAttributes attributes=File.GetAttributes(entry); Need((attributes & FileAttributes.ReparsePoint)==0);
            if((attributes & FileAttributes.Directory)!=0) Grant(entry,sid);
            else { FileSecurity security=File.GetAccessControl(entry); security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,FileSystemRights.FullControl,AccessControlType.Allow)); security.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.Modify,AccessControlType.Allow)); File.SetAccessControl(entry,security); LowLabel(entry); }
        }
        DirectorySecurity acl=Directory.GetAccessControl(root); acl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow)); acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.Modify,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow)); Directory.SetAccessControl(root,acl); LowLabel(root);
    }
    static int Main(string[] args) {
        Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
        var serializer=new JavaScriptSerializer(); serializer.MaxJsonLength=500000;
        try {
            // Only the trusted parent calls this with a profile name received from this helper's control pipe.
            if(args.Length==2 && args[0]=="--cleanup" && Regex.IsMatch(args[1],"^lca\\.desk\\.[a-f0-9]{32}$")) {
                int hr=DeleteAppContainerProfile(args[1]); Console.WriteLine(serializer.Serialize(new {profileRemoved=hr==0})); return hr==0?0:1;
            }
            Need(args.Length==0);
            string line=Console.ReadLine(); Need(line!=null && line.Length<=120000);
            var input=serializer.Deserialize<Dictionary<string,object>>(line);
            string root=Path.GetFullPath((string)input["root"]); string command=(string)input["command"]; int timeout=Convert.ToInt32(input["timeoutMs"]);
            Need(Path.GetFileName(root).StartsWith("lca-command-",StringComparison.Ordinal) && Directory.Exists(root) && (File.GetAttributes(root)&FileAttributes.ReparsePoint)==0);
            Need(command.Length>0 && command.Length<=6000 && command.IndexOf('\0')<0 && command.IndexOf('\r')<0 && command.IndexOf('\n')<0 && timeout>=500 && timeout<=30000);
            Console.WriteLine(serializer.Serialize(Run(root,command,timeout))); return 0;
        } catch(Exception error) {
            // No exception text, paths, command, environment or Win32 messages leave the trusted helper.
            string code=error is InvalidOperationException && error.Message.StartsWith("win32-",StringComparison.Ordinal) ? error.Message : "sandbox-unavailable";
            Console.WriteLine(serializer.Serialize(new { status="unavailable", stage=stage, error=code })); return 1;
        }
    }
    static object Run(string root,string command,int timeout) {
        string name="lca.desk."+Guid.NewGuid().ToString("N"); IntPtr sid=IntPtr.Zero,job=IntPtr.Zero,attributes=IntPtr.Zero,caps=IntPtr.Zero,handles=IntPtr.Zero,environment=IntPtr.Zero;
        IntPtr outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,nul=IntPtr.Zero; PI process=new PI(); bool initialized=false;
        var stop=new ManualResetEvent(false); var watch=Stopwatch.StartNew(); int bytes=0; bool overflow=false; var stdout=new MemoryStream(); var stderr=new MemoryStream(); Thread outThread=null,errThread=null;
        try {
            stage="profile"; int hr=CreateAppContainerProfile(name,name,"Disposable desk command",IntPtr.Zero,0,out sid); if(hr!=0)throw new InvalidOperationException("win32-"+hr.ToString());
            Console.WriteLine(new JavaScriptSerializer().Serialize(new {kind="profile",name=name})); Console.Out.Flush();
            stage="acl"; Grant(root,new SecurityIdentifier(sid)); string temp=Path.Combine(root,".lca-runtime"); Directory.CreateDirectory(temp);
            stage="job";
            job=CreateJobObject(IntPtr.Zero,null); Need(job!=IntPtr.Zero);
            Limits limits=new Limits(); limits.basic.flags=0x2000|0x8|0x200; limits.basic.active=8; limits.jobMemory=new UIntPtr(512UL*1024*1024);
            IntPtr limitData=Value(limits); try{Need(SetInformationJobObject(job,9,limitData,(uint)Marshal.SizeOf(typeof(Limits))));}finally{Marshal.FreeHGlobal(limitData);}
            IntPtr ui=Value((uint)0xff);try{Need(SetInformationJobObject(job,4,ui,4));}finally{Marshal.FreeHGlobal(ui);}
            stage="pipes"; SA sa=new SA {length=Marshal.SizeOf(typeof(SA)),inherit=1}; Need(CreatePipe(out outRead,out outWrite,ref sa,0)); Need(CreatePipe(out errRead,out errWrite,ref sa,0));
            Need(SetHandleInformation(outRead,1,0)); Need(SetHandleInformation(errRead,1,0));
            nul=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero); Need(nul!=new IntPtr(-1));
            stage="attributes"; IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size); Need(size!=IntPtr.Zero); attributes=Marshal.AllocHGlobal(size); Need(InitializeProcThreadAttributeList(attributes,2,0,ref size)); initialized=true;
            caps=Value(new Caps {sid=sid}); Need(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20009),caps,new IntPtr(Marshal.SizeOf(typeof(Caps))),IntPtr.Zero,IntPtr.Zero));
            handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,nul); Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handles,IntPtr.Size*2,errWrite);
            Need(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
            string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows); string powershell=Path.Combine(windows,"System32","WindowsPowerShell","v1.0","powershell.exe");
            var env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase) { {"SystemRoot",windows},{"WINDIR",windows},{"SystemDrive",Path.GetPathRoot(windows).TrimEnd('\\')},{"TEMP",temp},{"TMP",temp},{"USERPROFILE",temp},{"LOCALAPPDATA",temp},{"APPDATA",temp},{"PATH",Path.Combine(windows,"System32")+";"+Path.GetDirectoryName(powershell)},{"PSModulePath",Path.Combine(windows,"System32","WindowsPowerShell","v1.0","Modules")},{"COMSPEC",Path.Combine(windows,"System32","cmd.exe")} };
            var block=new StringBuilder(); foreach(var pair in env)block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0'); block.Append('\0'); environment=Marshal.StringToHGlobalUni(block.ToString());
            string shell=Path.Combine(windows,"System32","cmd.exe"); SX startup=new SX(); startup.si.cb=Marshal.SizeOf(typeof(SX)); startup.si.flags=0x101; startup.si.stdin=nul; startup.si.stdout=outWrite; startup.si.stderr=errWrite; startup.attributes=attributes;
            stage="launch"; Need(CreateProcess(shell,new StringBuilder("\""+shell+"\" /d /q /s /c \"chcp 65001>nul & "+command+"\""),IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|4|0x8000000,environment,root,ref startup,out process));
            // No untrusted instruction runs before the process is in the kill-on-close job and its token is checked.
            stage="token"; Need(AssignProcessToJobObject(job,process.process)); IntPtr token=IntPtr.Zero,info=Marshal.AllocHGlobal(4); int needed;
            try{Need(OpenProcessToken(process.process,8,out token)); Need(GetTokenInformation(token,29,info,4,out needed)); Need(Marshal.ReadInt32(info)!=0);}finally{Marshal.FreeHGlobal(info);Close(ref token);}
            Close(ref outWrite); Close(ref errWrite); Close(ref nul);
            Action<IntPtr,MemoryStream> pump=(handle,output)=>{ try{using(var stream=new FileStream(new SafeFileHandle(handle,false),FileAccess.Read)){byte[] buffer=new byte[4096];int n;while((n=stream.Read(buffer,0,buffer.Length))>0){if(Interlocked.Add(ref bytes,n)>65536){overflow=true;stop.Set();break;}output.Write(buffer,0,n);}}}catch{stop.Set();} };
            IntPtr outHandle=outRead,errHandle=errRead; outThread=new Thread(()=>pump(outHandle,stdout)); errThread=new Thread(()=>pump(errHandle,stderr)); outThread.IsBackground=true;errThread.IsBackground=true;outThread.Start();errThread.Start();
            var cancellation=new Thread(()=>{try{Console.ReadLine();stop.Set();}catch(ObjectDisposedException){}});cancellation.IsBackground=true;cancellation.Start();
            Need(ResumeThread(process.thread)!=0xffffffff); string status="completed";
            while(WaitForSingleObject(process.process,50)==258){if(stop.WaitOne(0)){status=overflow?"output-limit":"cancelled";break;}if(watch.ElapsedMilliseconds>=timeout){status="timeout";break;}}
            uint exitCode; Need(GetExitCodeProcess(process.process,out exitCode)); TerminateJobObject(job,1); WaitForSingleObject(process.process,2000);
            Need(outThread.Join(2000) && errThread.Join(2000)); if(overflow)status="output-limit";
            return new {status=status,exitCode=status=="completed"?(int?)exitCode:null,stdout=Encoding.UTF8.GetString(stdout.ToArray()),stderr=Encoding.UTF8.GetString(stderr.ToArray()),appContainer=true,networkCapabilities=0,processTreeTerminated=true,elapsedMs=watch.ElapsedMilliseconds};
        } finally {
            if(job!=IntPtr.Zero)TerminateJobObject(job,1);if(process.process!=IntPtr.Zero){TerminateProcess(process.process,1);WaitForSingleObject(process.process,2000);}Close(ref process.thread);Close(ref process.process);Close(ref job);
            Close(ref outRead);Close(ref outWrite);Close(ref errRead);Close(ref errWrite);Close(ref nul);
            if(initialized)DeleteProcThreadAttributeList(attributes);Free(ref attributes);Free(ref caps);Free(ref handles);Free(ref environment);
            if(sid!=IntPtr.Zero){DeleteAppContainerProfile(name);FreeSid(sid);}stdout.Dispose();stderr.Dispose();stop.Dispose();
        }
    }
}
