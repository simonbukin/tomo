use crate::daemon::Daemon;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tomo_proto::*;

const PUSH_EVERY: Duration = Duration::from_secs(5);
const CPU_STALE: Duration = Duration::from_secs(10);
const CPU_WINDOW: Duration = Duration::from_millis(300);

#[derive(Debug, Default, PartialEq)]
pub struct Gpu {
    pub percent: Option<f32>,
    pub vram_used_bytes: Option<u64>,
    pub vram_total_bytes: Option<u64>,
}

fn performance_statistics(line: &str) -> Option<HashMap<&str, u64>> {
    let body = line.split_once("\"PerformanceStatistics\" = {")?.1.rsplit_once('}')?.0;
    Some(
        body.split(',')
            .filter_map(|pair| {
                let (key, value) = pair.split_once('=')?;
                Some((key.trim().trim_matches('"'), value.trim().parse::<u64>().ok()?))
            })
            .collect(),
    )
}

/// Reads `ioreg -r -d 1 -w 0 -c IOAccelerator`. Apple silicon reports only
/// `Device Utilization %` (unified memory, so no VRAM). Discrete AMD and Intel
/// drivers also report `vramUsedBytes` and `vramFreeBytes`.
pub fn parse_ioreg(text: &str) -> Gpu {
    let stats: Vec<HashMap<&str, u64>> = text.lines().filter_map(performance_statistics).collect();
    let percent = stats.iter().filter_map(|s| s.get("Device Utilization %").copied()).max().map(|p| p.min(100) as f32);
    let vram: Vec<(u64, u64)> = stats.iter().filter_map(|s| Some((*s.get("vramUsedBytes")?, *s.get("vramFreeBytes")?))).collect();
    let used: u64 = vram.iter().map(|(u, _)| u).sum();
    let total: u64 = vram.iter().map(|(u, f)| u + f).sum();
    let has_vram = !vram.is_empty() && total > 0;
    Gpu { percent, vram_used_bytes: has_vram.then_some(used), vram_total_bytes: has_vram.then_some(total) }
}

#[cfg(target_os = "macos")]
fn read_gpu() -> Gpu {
    std::process::Command::new("/usr/sbin/ioreg")
        .args(["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_ioreg(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn read_gpu() -> Gpu {
    Gpu::default()
}

/// Blocking: `ioreg` runs before the lock is taken.
fn sample(daemon: &Arc<Daemon>) -> SystemStats {
    let gpu = read_gpu();
    let mut inner = daemon.lock();
    let machine = inner.procs.machine();
    SystemStats {
        at_ms: now_ms(),
        cpu_percent: machine.cpu_percent,
        memory_used_bytes: machine.memory_used_bytes,
        memory_total_bytes: machine.memory_total_bytes,
        gpu_percent: gpu.percent,
        vram_used_bytes: gpu.vram_used_bytes,
        vram_total_bytes: gpu.vram_total_bytes,
        daemon_rss_bytes: machine.own_rss_bytes,
        top_worktree: inner.resources.iter().filter(|r| r.rss_bytes > 0).max_by_key(|r| r.rss_bytes).cloned(),
    }
}

/// A sample whose CPU figure covers a short recent window, not the time since the last caller.
pub async fn fresh(daemon: &Arc<Daemon>) -> SystemStats {
    let stale = daemon.lock().procs.machine_age().map_or(true, |age| age > CPU_STALE);
    if stale {
        daemon.lock().procs.machine();
        tokio::time::sleep(CPU_WINDOW).await;
    }
    let d = daemon.clone();
    tokio::task::spawn_blocking(move || sample(&d)).await.unwrap_or_default()
}

pub async fn run(daemon: Arc<Daemon>) {
    loop {
        tokio::time::sleep(PUSH_EVERY).await;
        if !daemon.lock().clients.values().any(|c| c.subscribed) {
            continue;
        }
        let stats = fresh(&daemon).await;
        Daemon::emit(&mut daemon.lock(), Event::SystemStats { stats });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPLE_SILICON: &str = r#"+-o AGXAcceleratorG17X  <class AGXAcceleratorG17X, id 0x1000004f6, registered, matched, active, busy 0 (228 ms), retain 79>
    {
      "SchedulerState" = {"Stamps"=(),"BusyWorkQueues"=()}
      "AGCInfo" = {"fLastSubmissionPID"=601,"fSubmissionsSinceLastCheck"=0,"fBusyCount"=0}
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=4082434048,"Tiler Utilization %"=10,"recoveryCount"=0,"lastRecoveryTime"=0,"Renderer Utilization %"=33,"TiledSceneBytes"=1540096,"Device Utilization %"=33,"SplitSceneCount"=0,"Allocated PB Size"=127401984,"In use system memory"=1210236928}
      "model" = "Apple M5 Pro"
      "gpu-core-count" = 16
    }
"#;

    const INTEL_WITH_AMD: &str = r#"+-o IntelAccelerator  <class IntelAccelerator, id 0x100000a1b, registered, matched, active, busy 0 (5 ms), retain 30>
    {
      "PerformanceStatistics" = {"Device Utilization %"=4,"GPU Activity(%)"=4,"inUseSysMemoryBytes"=123}
    }
+-o AMDRadeonX6000_AMDNavi14GraphicsAccelerator  <class AMDRadeonX6000_AMDNavi14GraphicsAccelerator, id 0x100000b2c, registered, matched, active, busy 0 (9 ms), retain 40>
    {
      "PerformanceStatistics" = {"Device Utilization %"=61,"vramUsedBytes"=1932735283,"vramFreeBytes"=6653214925,"Temperature(C)"=58}
    }
"#;

    #[test]
    fn apple_silicon_reports_utilization_without_vram() {
        assert_eq!(parse_ioreg(APPLE_SILICON), Gpu { percent: Some(33.0), vram_used_bytes: None, vram_total_bytes: None });
    }

    #[test]
    fn discrete_gpu_reports_the_busiest_device_and_vram() {
        assert_eq!(
            parse_ioreg(INTEL_WITH_AMD),
            Gpu { percent: Some(61.0), vram_used_bytes: Some(1932735283), vram_total_bytes: Some(1932735283 + 6653214925) }
        );
    }

    #[test]
    fn missing_or_garbled_output_is_none() {
        assert_eq!(parse_ioreg(""), Gpu::default());
        assert_eq!(parse_ioreg("\"PerformanceStatistics\" = {\"Device Utilization %\"=abc}"), Gpu::default());
        assert_eq!(parse_ioreg("\"PerformanceStatistics\" = {\"Device Utilization %\"=250}").percent, Some(100.0));
    }
}
