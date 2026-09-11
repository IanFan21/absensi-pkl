(function() {
// ============ KONFIGURASI ============
// GANTI baris di bawah ini dengan URL Web App dari Google Apps Script Anda.
// Lihat PANDUAN_SETUP.md untuk cara mendapatkannya.
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwQ7pYKl_I75FZgdE8-WtVHswfD_aGy0HE182ETL1pw1rwfCC-g5h2DI4VbLY2lIn0prw/exec';

// Kode akses pintu depan sekarang dicek di SERVER (bukan di sini lagi), supaya
// tidak bisa dibaca lewat Inspect Element / View Source. Untuk mengganti kode
// akses, gunakan tab Pengaturan setelah masuk sebagai Guru.

let _jsonpCounter = 0;
function api(action, payload) {
  payload = payload || {};
  payload.action = action;
  return new Promise((resolve, reject) => {
    const cbName = 'pklCb_' + (_jsonpCounter++) + '_' + Date.now();
    const script = document.createElement('script');
    let selesai = false;
    const bersihkan = () => {
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    };
    window[cbName] = function(data) {
      selesai = true;
      bersihkan();
      resolve(data);
    };
    script.onerror = function() {
      if (!selesai) { bersihkan(); reject(new Error('Gagal memuat data dari server')); }
    };
    const url = APPS_SCRIPT_URL + '?payload=' + encodeURIComponent(JSON.stringify(payload)) + '&callback=' + cbName;
    script.src = url;
    document.body.appendChild(script);
    setTimeout(() => { if (!selesai) { bersihkan(); reject(new Error('Waktu permintaan habis, coba lagi')); } }, 20000);
  });
}

// Kirim foto lewat POST "no-cors" (fire-and-forget) supaya tidak kena blokir CORS
// yang biasa terjadi pada respons POST Apps Script. Kita tidak perlu membaca
// balasannya, cukup menunggu request-nya selesai diproses server.
async function apiUploadFoto(uploadId, fotoBase64) {
  await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'uploadFotoOnly', uploadId, fotoBase64 })
  });
}

// ============ STATE ============
let siswaSession = null;      // { id, nama, pin, tempatPkl, sekolah, kota, jurusan }
let guruPassword = null;
let guruData = { anak: [], absensi: [] };
let chartInstance = null;
let currentMingguInfo = null;
let statusMingguan = {};
let hariAktifCepatSet = null;
let siswaFotoDataUrl = '';

const today = new Date();
const currentMonth = today.getMonth();
const currentYear = today.getFullYear();
const DRAFT_MINGGUAN_PREFIX = 'absensi_pkl_v5_draft_mg_';

// ============ UTIL UMUM ============
function formatDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function formatDateIndo(dateStr) {
  const d = new Date(dateStr);
  const namaHari = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const namaBulan = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  return `${namaHari[d.getDay()]}, ${d.getDate()} ${namaBulan[d.getMonth()]} ${d.getFullYear()}`;
}
function getWeeksInMonth(month, year) {
  const weeks = [];
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  let weekStart = new Date(firstDay);
  while (weekStart.getDay() !== 1) weekStart.setDate(weekStart.getDate() - 1);
  while (weekStart <= lastDay) {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const actualStart = weekStart < firstDay ? firstDay : weekStart;
    const actualEnd = weekEnd > lastDay ? lastDay : weekEnd;
    weeks.push({ start: new Date(actualStart), end: new Date(actualEnd) });
    weekStart.setDate(weekStart.getDate() + 7);
  }
  return weeks;
}
function getHariKerja(minggu) {
  const hari = [];
  const namaHari = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
  const current = new Date(minggu.start);
  while (current <= minggu.end) {
    hari.push({ tanggal: formatDate(current), label: namaHari[current.getDay()] + ', ' + current.getDate(), dateObj: new Date(current) });
    current.setDate(current.getDate() + 1);
  }
  return hari;
}
function getStatusClass(s) {
  return s === 'hadir' ? 'status-hadir' : s === 'izin' ? 'status-izin' : s === 'alpa' ? 'status-alpa' : s === 'libur' ? 'status-libur' : s === 'pending' ? 'status-pending' : 'status-belum';
}
function getStatusLabel(s) {
  return s === 'hadir' ? 'Hadir' : s === 'izin' ? 'Izin' : s === 'alpa' ? 'Alpa' : s === 'libur' ? 'Libur' : s === 'pending' ? 'Menunggu Review' : 'Belum';
}
function getAnakUrutTempat() {
  return [...guruData.anak].sort((a, b) => {
    const ta = (a.tempatPkl||'').toLowerCase(), tb = (b.tempatPkl||'').toLowerCase();
    if (ta !== tb) return ta.localeCompare(tb);
    return (a.nama||'').localeCompare(b.nama||'');
  });
}
function cariAnak(id) { return guruData.anak.find(a => a.id === id); }

// ============ NAVIGASI LAYAR ============
function showScreen(name) {
  ['KodeAkses','Role','GuruLogin','Siswa','Guru'].forEach(s => {
    document.getElementById('screen' + s).style.display = (s === name) ? 'block' : 'none';
  });
}
window.kembaliKePilihPeran = function() { showScreen('Role'); };

window.pilihPeranGuru = function() { showScreen('GuruLogin'); };
window.pilihPeranSiswa = function() { showScreen('Siswa'); loadPublicAnakList(); };

window.doCekKodeAkses = async function() {
  const val = document.getElementById('kodeAksesInput').value;
  const errEl = document.getElementById('kodeAksesError');
  errEl.style.display = 'none';
  const btn = document.getElementById('btnCekKodeAkses');
  if (btn) { btn.disabled = true; btn.textContent = 'Memeriksa…'; }
  let r;
  try {
    r = await api('cekKodeAkses', { kode: val });
  } catch (e) {
    errEl.textContent = 'Gagal terhubung ke server. Cek koneksi internet.';
    errEl.style.display = 'block';
    if (btn) { btn.disabled = false; btn.textContent = 'Buka'; }
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Buka'; }
  if (!r.ok) {
    errEl.textContent = r.error || 'Kode akses salah.';
    errEl.style.display = 'block';
    return;
  }
  try { sessionStorage.setItem('pklAksesTerbuka', '1'); } catch(e) {}
  showScreen('Role');
};

if ((function(){ try { return sessionStorage.getItem('pklAksesTerbuka') === '1'; } catch(e) { return false; } })()) {
  showScreen('Role');
} else {
  showScreen('KodeAkses');
}

if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf('GANTI_DENGAN') !== -1) {
  document.getElementById('urlBelumDiset').style.display = 'block';
}

// ============ SISWA ============
async function loadPublicAnakList() {
  const sel = document.getElementById('siswaNamaSelect');
  try {
    const r = await api('getPublicAnakList');
    if (r.ok) {
      sel.innerHTML = '<option value="">Pilih nama…</option>' + r.anak.map(a => `<option value="${a.nama.replace(/"/g,'&quot;')}">${a.nama}</option>`).join('');
    } else {
      sel.innerHTML = '<option value="">Gagal memuat</option>';
    }
  } catch (e) {
    sel.innerHTML = '<option value="">Gagal memuat (cek koneksi)</option>';
  }
}

window.doLoginSiswa = async function() {
  const nama = document.getElementById('siswaNamaSelect').value;
  const pin = document.getElementById('siswaPinInput').value.trim();
  const errEl = document.getElementById('siswaLoginError');
  errEl.style.display = 'none';
  if (!nama) { errEl.textContent = 'Pilih nama dulu.'; errEl.style.display = 'block'; return; }
  if (!pin) { errEl.textContent = 'Masukkan PIN.'; errEl.style.display = 'block'; return; }
  let r;
  try {
    r = await api('loginSiswa', { nama, pin });
  } catch (e) {
    errEl.textContent = 'Gagal terhubung ke server. Pastikan file ini dibuka lewat link https (bukan dibuka langsung dari file di komputer), dan cek koneksi internet.';
    errEl.style.display = 'block';
    return;
  }
  if (!r.ok) { errEl.textContent = r.error || 'Gagal masuk.'; errEl.style.display = 'block'; return; }
  siswaSession = { ...r.anak, pin };
  document.getElementById('siswaLoginBox').style.display = 'none';
  document.getElementById('siswaDashboard').style.display = 'block';
  document.getElementById('siswaNamaLabel').textContent = siswaSession.nama;
  document.getElementById('siswaTempatLabel').textContent = 'PKL di ' + (siswaSession.tempatPkl || '-');
  document.getElementById('siswaTanggalLabel').textContent = formatDateIndo(formatDate(today));
  loadMyHistory();
};

window.logoutSiswa = function() {
  siswaSession = null;
  siswaFotoDataUrl = '';
  document.getElementById('siswaFotoInput').value = '';
  document.getElementById('siswaFotoPreview').style.display = 'none';
  document.getElementById('siswaKegiatanInput').value = '';
  document.getElementById('siswaPinInput').value = '';
  document.getElementById('siswaLoginBox').style.display = 'block';
  document.getElementById('siswaDashboard').style.display = 'none';
};

document.getElementById('siswaFotoInput').addEventListener('change', async function(e) {
  const file = e.target.files[0];
  if (!file) return;
  siswaFotoDataUrl = await compressImage(file, 900, 0.6);
  const preview = document.getElementById('siswaFotoPreview');
  preview.src = siswaFotoDataUrl;
  preview.style.display = 'block';
});

function compressImage(file, maxWidth, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function(ev) {
      const img = new Image();
      img.onload = function() {
        let w = img.width, h = img.height;
        if (w > maxWidth) { h = Math.round(h * (maxWidth / w)); w = maxWidth; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

window.doSubmitAbsen = async function() {
  const kegiatan = document.getElementById('siswaKegiatanInput').value.trim();
  const msgEl = document.getElementById('siswaSubmitMsg');
  msgEl.style.display = 'none';
  if (!siswaFotoDataUrl) { alert('Foto wajib diunggah!'); return; }
  if (!kegiatan) { alert('Isi kegiatan hari ini!'); return; }
  const btn = document.getElementById('btnKirimAbsen');
  btn.disabled = true; btn.textContent = 'Mengirim…';
  try {
    const uploadId = 'foto_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await apiUploadFoto(uploadId, siswaFotoDataUrl);
    const r = await api('submitAbsen', {
      anakId: siswaSession.id, pin: siswaSession.pin,
      tanggal: formatDate(today), kegiatan, uploadId
    });
    if (r.ok) {
      msgEl.style.color = 'var(--success)';
      msgEl.textContent = '✅ Terkirim! Menunggu review dari Bapak/Ibu Guru.';
      msgEl.style.display = 'block';
      document.getElementById('siswaKegiatanInput').value = '';
      document.getElementById('siswaFotoInput').value = '';
      document.getElementById('siswaFotoPreview').style.display = 'none';
      siswaFotoDataUrl = '';
      loadMyHistory();
    } else {
      msgEl.style.color = 'var(--danger)';
      msgEl.textContent = '❌ ' + (r.error || 'Gagal mengirim.');
      msgEl.style.display = 'block';
    }
  } catch (e) {
    msgEl.style.color = 'var(--danger)';
    msgEl.textContent = '❌ Gagal mengirim, cek koneksi internet.';
    msgEl.style.display = 'block';
  }
  btn.disabled = false; btn.textContent = '📤 Kirim Absen';
};

async function loadMyHistory() {
  const container = document.getElementById('siswaRiwayat');
  container.innerHTML = '<p style="color:var(--muted);font-size:13px;">Memuat…</p>';
  const r = await api('getMyAbsensi', { anakId: siswaSession.id, pin: siswaSession.pin });
  if (!r.ok) { container.innerHTML = '<p style="color:var(--danger);font-size:13px;">Gagal memuat riwayat.</p>'; return; }
  const list = r.absensi.sort((a,b) => (b.tanggal+b.waktuKirim).localeCompare(a.tanggal+a.waktuKirim)).slice(0, 30);
  if (list.length === 0) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;text-align:center;padding:12px;">Belum ada riwayat.</p>'; return; }
  container.innerHTML = list.map(a => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;border-radius:8px;background:var(--bg);border:1px solid var(--border);gap:8px;flex-wrap:wrap;">
      <div>
        <div style="font-size:13px;font-weight:500;">${formatDateIndo(a.tanggal)}</div>
        <div style="font-size:11px;color:var(--muted);">${(a.kegiatan||'').slice(0,60)}${a.catatanGuru ? ' · Catatan guru: ' + a.catatanGuru : ''}</div>
      </div>
      <span class="${getStatusClass(a.status)}" style="padding:3px 10px;border-radius:20px;font-size:12px;font-weight:500;">${getStatusLabel(a.status)}</span>
    </div>
  `).join('');
}

// ============ GURU: LOGIN & DATA ============
window.doLoginGuru = async function() {
  const pw = document.getElementById('guruPasswordInput').value;
  const errEl = document.getElementById('guruLoginError');
  errEl.style.display = 'none';
  let r;
  try {
    r = await api('loginGuru', { password: pw });
  } catch (e) {
    errEl.textContent = 'Gagal terhubung ke server. Pastikan file ini dibuka lewat link https (bukan dibuka langsung dari file di komputer), dan cek koneksi internet.';
    errEl.style.display = 'block';
    return;
  }
  if (!r.ok) { errEl.textContent = r.error || 'Password salah'; errEl.style.display = 'block'; return; }
  guruPassword = pw;
  document.getElementById('guruPasswordInput').value = '';
  showScreen('Guru');
  initGuruApp();
};

window.logoutGuru = function() {
  guruPassword = null;
  guruData = { anak: [], absensi: [] };
  showScreen('Role');
};

function initGuruApp() {
  initBulanTahun();
  document.getElementById('manualTanggal').value = formatDate(today);
  loadGuruData();
}

window.loadGuruData = async function() {
  let r;
  try {
    r = await api('getAllForGuru', { password: guruPassword });
  } catch (e) {
    alert('Gagal terhubung ke server. Pastikan file ini dibuka lewat link https (bukan dibuka langsung dari file di komputer), dan cek koneksi internet.');
    return;
  }
  if (!r.ok) { alert('Gagal memuat data: ' + (r.error||'')); return; }
  guruData = { anak: r.anak, absensi: r.absensi };
  refreshAnakSelects();
  initMingguSelect();
  const activeTab = document.querySelector('.tab-btn.active');
  showTab(currentActiveTab());
};

function currentActiveTab() {
  const tabs = ['dashboard','review','mingguan','riwayat','anak','pengaturan'];
  for (const t of tabs) {
    if (document.getElementById('tab-' + t).style.display !== 'none') return t;
  }
  return 'dashboard';
}

function initBulanTahun() {
  const bulanSelect = document.getElementById('bulanSelect');
  const tahunSelect = document.getElementById('tahunSelect');
  const namaBulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  bulanSelect.innerHTML = namaBulan.map((b,i) => `<option value="${i}" ${i===currentMonth?'selected':''}>${b}</option>`).join('');
  const opts = [];
  for (let y = currentYear - 1; y <= currentYear + 1; y++) opts.push(`<option value="${y}" ${y===currentYear?'selected':''}>${y}</option>`);
  tahunSelect.innerHTML = opts.join('');
  bulanSelect.onchange = () => { initMingguSelect(); showTab(currentActiveTab()); };
  tahunSelect.onchange = () => { initMingguSelect(); showTab(currentActiveTab()); };
}

window.showTab = function(tabName) {
  ['dashboard','review','mingguan','riwayat','anak','pengaturan'].forEach(t => {
    document.getElementById('tab-' + t).style.display = (t === tabName) ? 'block' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    const tabs = ['dashboard','review','mingguan','riwayat','anak','pengaturan'];
    btn.classList.toggle('active', tabs[i] === tabName);
  });
  if (tabName === 'dashboard') { renderDashboard(); setTimeout(() => { if (chartInstance) chartInstance.resize(); }, 50); }
  if (tabName === 'review') renderReviewTab();
  if (tabName === 'mingguan') renderMingguanBaru();
  if (tabName === 'riwayat') renderRiwayat();
  if (tabName === 'anak') renderDaftarAnak();
  updateBadgePending();
};

function updateBadgePending() {
  const n = guruData.absensi.filter(a => a.status === 'pending').length;
  const badge = document.getElementById('badgePending');
  if (n > 0) { badge.textContent = n; badge.style.display = 'inline-block'; }
  else badge.style.display = 'none';
}

function refreshAnakSelects() {
  const anakUrut = getAnakUrutTempat();
  const filterAnak = document.getElementById('filterAnak');
  const manualAnak = document.getElementById('manualAnak');
  filterAnak.innerHTML = '<option value="semua">Semua Anak</option>' + anakUrut.map(a => `<option value="${a.id}">${a.nama}</option>`).join('');
  manualAnak.innerHTML = anakUrut.length ? anakUrut.map(a => `<option value="${a.id}">${a.nama} — ${a.tempatPkl||''}</option>`).join('') : '<option value="">Belum ada data anak</option>';
}

// ============ DASHBOARD ============
function renderDashboard() {
  const bulan = parseInt(document.getElementById('bulanSelect').value);
  const tahun = parseInt(document.getElementById('tahunSelect').value);
  const filterSumber = document.getElementById('filterSumberDashboard').value;

  let absenBulanIni = guruData.absensi.filter(a => {
    const d = new Date(a.tanggal);
    return d.getMonth() === bulan && d.getFullYear() === tahun;
  });
  if (filterSumber !== 'semua') absenBulanIni = absenBulanIni.filter(a => a.sumber === filterSumber);

  document.getElementById('statHadir').textContent = absenBulanIni.filter(a => a.status === 'hadir').length;
  document.getElementById('statIzin').textContent = absenBulanIni.filter(a => a.status === 'izin').length;
  document.getElementById('statAlpa').textContent = absenBulanIni.filter(a => a.status === 'alpa').length;
  document.getElementById('statLibur').textContent = absenBulanIni.filter(a => a.status === 'libur').length;
  document.getElementById('statPending').textContent = absenBulanIni.filter(a => a.status === 'pending').length;
  document.getElementById('statAnak').textContent = guruData.anak.length;

  renderChartMingguan(bulan, tahun, filterSumber);
  renderRingkasanAnak(bulan, tahun, filterSumber);
}

function renderChartMingguan(bulan, tahun, filterSumber) {
  const el = document.getElementById('chartMingguan');
  if (!el) return;
  if (typeof echarts === 'undefined') { setTimeout(() => renderChartMingguan(bulan, tahun, filterSumber), 200); return; }
  if (chartInstance) chartInstance.dispose();
  chartInstance = echarts.init(el);
  const weeks = getWeeksInMonth(bulan, tahun);
  const weekLabels = weeks.map((w,i) => `Mg ${i+1}`);
  const hadirData=[], izinData=[], alpaData=[], liburData=[];
  weeks.forEach(w => {
    let h=0,i=0,a=0,l=0;
    guruData.absensi.forEach(absen => {
      const d = new Date(absen.tanggal);
      if (d >= w.start && d <= w.end) {
        if (filterSumber !== 'semua' && absen.sumber !== filterSumber) return;
        if (absen.status === 'hadir') h++;
        else if (absen.status === 'izin') i++;
        else if (absen.status === 'alpa') a++;
        else if (absen.status === 'libur') l++;
      }
    });
    hadirData.push(h); izinData.push(i); alpaData.push(a); liburData.push(l);
  });
  chartInstance.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    legend: { data: ['Hadir','Izin','Alpa','Libur'], top: 0, textStyle: { color: '#64748b', fontSize: 11 } },
    grid: { left: '3%', right: '4%', bottom: '3%', top: '18%', containLabel: true },
    xAxis: { type: 'category', data: weekLabels, axisLabel: { color: '#64748b', fontSize: 11 } },
    yAxis: { type: 'value', axisLabel: { color: '#64748b', fontSize: 11 }, splitLine: { lineStyle: { color: 'rgba(15,23,42,.06)' } } },
    series: [
      { name:'Hadir', type:'bar', stack:'total', data:hadirData, itemStyle:{ color:'#297a2e', borderRadius:[4,4,0,0] } },
      { name:'Izin', type:'bar', stack:'total', data:izinData, itemStyle:{ color:'#d97706' } },
      { name:'Alpa', type:'bar', stack:'total', data:alpaData, itemStyle:{ color:'#dc2626' } },
      { name:'Libur', type:'bar', stack:'total', data:liburData, itemStyle:{ color:'#7c3aed' } }
    ]
  }, true);
  window.removeEventListener('resize', window._chartResizeHandler);
  window._chartResizeHandler = () => chartInstance.resize();
  window.addEventListener('resize', window._chartResizeHandler);
}

function renderRingkasanAnak(bulan, tahun, filterSumber) {
  const container = document.getElementById('ringkasanAnak');
  const anakUrut = getAnakUrutTempat();
  if (anakUrut.length === 0) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:12px;text-align:center;">Belum ada data anak PKL.</p>'; return; }

  let html = `<p style="font-size:11px;color:var(--muted);margin-bottom:8px;">Filter: <strong>${filterSumber === 'semua' ? 'Semua Sumber' : filterSumber === 'siswa' ? 'Kiriman Siswa' : filterSumber === 'mingguan' ? 'Kunjungan Mingguan' : 'Input Manual'}</strong></p>`;
  let lastTempat = '';
  anakUrut.forEach(anak => {
    const tempat = anak.tempatPkl || 'Tidak diketahui';
    if (tempat !== lastTempat) { html += `<div class="tempat-pkl-group">📍 ${tempat}</div>`; lastTempat = tempat; }

    let semuaAbsen = guruData.absensi.filter(a => {
      const d = new Date(a.tanggal);
      return a.anakId === anak.id && d.getMonth() === bulan && d.getFullYear() === tahun;
    });
    if (filterSumber !== 'semua') semuaAbsen = semuaAbsen.filter(a => a.sumber === filterSumber);

    const hitung = arr => ({
      h: arr.filter(a => a.status === 'hadir').length,
      i: arr.filter(a => a.status === 'izin').length,
      a: arr.filter(a => a.status === 'alpa').length,
      l: arr.filter(a => a.status === 'libur').length,
      p: arr.filter(a => a.status === 'pending').length
    });
    const c = hitung(semuaAbsen);
    const totalSemua = c.h + c.i + c.a || 1;
    const persenHadir = Math.round((c.h / totalSemua) * 100);

    html += `
      <div style="padding:12px;border-radius:10px;background:var(--bg);border:1px solid var(--border);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:4px;">
          <div style="font-weight:600;font-size:14px;">${anak.nama}</div>
          <div style="font-size:12px;color:var(--accent);font-weight:600;">Hadir: ${persenHadir}%</div>
        </div>
        <div style="display:flex;gap:8px;font-size:12px;flex-wrap:wrap;margin-bottom:8px;">
          <span style="color:var(--success);">Hadir:${c.h}</span>
          <span style="color:var(--warning);">Izin:${c.i}</span>
          <span style="color:var(--danger);">Alpa:${c.a}</span>
          <span style="color:var(--libur);">Libur:${c.l}</span>
          ${c.p > 0 ? `<span style="color:var(--pending);">Menunggu:${c.p}</span>` : ''}
        </div>
        <div style="height:6px;background:rgba(128,128,128,.1);border-radius:3px;overflow:hidden;">
          <div style="height:100%;width:${persenHadir}%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;"></div>
        </div>
      </div>`;
  });
  container.innerHTML = html;
}

// ============ REVIEW SISWA ============
function renderReviewTab() {
  renderReviewQueue();
  renderReviewedList();
}

function renderReviewQueue() {
  const container = document.getElementById('reviewQueue');
  const pending = guruData.absensi.filter(a => a.status === 'pending').sort((a,b) => (a.waktuKirim||'').localeCompare(b.waktuKirim||''));
  if (pending.length === 0) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:12px;text-align:center;">Tidak ada kiriman yang menunggu review. 🎉</p>'; return; }
  container.innerHTML = pending.map(a => {
    const anak = cariAnak(a.anakId);
    return `
    <div class="review-card">
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${a.foto ? `<a href="${a.foto}" target="_blank"><img src="${a.foto}" class="foto-thumb" style="max-width:160px;"></a>` : '<div style="width:160px;height:100px;background:var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted);">Tanpa foto</div>'}
        <div style="flex:1;min-width:180px;">
          <div style="font-weight:600;font-size:15px;">${anak ? anak.nama : '(anak tidak ditemukan)'}</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:4px;">${anak ? anak.tempatPkl : ''} · ${formatDateIndo(a.tanggal)}</div>
          <div style="font-size:13px;">${(a.kegiatan||'').replace(/</g,'&lt;')}</div>
        </div>
      </div>
      <input type="text" class="input-field" placeholder="Catatan guru (opsional)" id="catatan_${a.id}" style="font-size:13px;padding:8px;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button onclick="prosesReview('${a.id}','hadir')" class="status-pill status-hadir" style="padding:8px 14px;font-size:13px;">✓ Hadir</button>
        <button onclick="prosesReview('${a.id}','izin')" class="status-pill status-izin" style="padding:8px 14px;font-size:13px;">📝 Izin</button>
        <button onclick="prosesReview('${a.id}','alpa')" class="status-pill status-alpa" style="padding:8px 14px;font-size:13px;">✗ Alpa</button>
        <button onclick="prosesReview('${a.id}','libur')" class="status-pill status-libur" style="padding:8px 14px;font-size:13px;">🏖 Libur</button>
      </div>
    </div>`;
  }).join('');
}

window.prosesReview = async function(id, status) {
  const catatanEl = document.getElementById('catatan_' + id);
  const catatanGuru = catatanEl ? catatanEl.value.trim() : '';
  const r = await api('reviewAbsen', { password: guruPassword, id, status, catatanGuru });
  if (!r.ok) { alert('Gagal menyimpan review: ' + (r.error||'')); return; }
  await loadGuruData();
  showTab('review');
};

function renderReviewedList() {
  const container = document.getElementById('reviewedList');
  const batas = new Date(); batas.setDate(batas.getDate() - 7);
  const list = guruData.absensi.filter(a => a.sumber === 'siswa' && a.status !== 'pending' && new Date(a.tanggal) >= batas)
    .sort((a,b) => (b.tanggal||'').localeCompare(a.tanggal||''));
  if (list.length === 0) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;text-align:center;padding:12px;">Belum ada.</p>'; return; }
  container.innerHTML = list.map(a => {
    const anak = cariAnak(a.anakId);
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-radius:8px;background:var(--bg);border:1px solid var(--border);gap:8px;flex-wrap:wrap;">
        <div>
          <div style="font-size:13px;font-weight:500;">${anak ? anak.nama : '-'}</div>
          <div style="font-size:11px;color:var(--muted);">${formatDateIndo(a.tanggal)}${a.catatanGuru ? ' · ' + a.catatanGuru : ''}</div>
        </div>
        <span class="${getStatusClass(a.status)}" style="padding:2px 10px;border-radius:12px;font-size:11px;font-weight:500;">${getStatusLabel(a.status)}</span>
      </div>`;
  }).join('');
}

window.toggleTambahManual = function() { document.getElementById('manualAccordion').classList.toggle('open'); };

window.simpanManual = async function() {
  const anakId = document.getElementById('manualAnak').value;
  const tanggal = document.getElementById('manualTanggal').value;
  const status = document.getElementById('manualStatus').value;
  const catatanGuru = document.getElementById('manualCatatan').value.trim();
  if (!anakId) { alert('Pilih anak!'); return; }
  if (!tanggal) { alert('Pilih tanggal!'); return; }
  const r = await api('saveManual', { password: guruPassword, anakId, tanggal, status, catatanGuru });
  if (!r.ok) { alert('Gagal menyimpan: ' + (r.error||'')); return; }
  document.getElementById('manualCatatan').value = '';
  await loadGuruData();
  showTab('review');
  alert('Tersimpan!');
};

// ============ ABSEN MINGGUAN ============
function buatDraftKeyMingguan(bulan, tahun, mingguKe) { return DRAFT_MINGGUAN_PREFIX + tahun + '_' + bulan + '_' + mingguKe; }
function simpanDraftMingguanLengkap() {
  if (!currentMingguInfo) return;
  const key = buatDraftKeyMingguan(currentMingguInfo.bulan, currentMingguInfo.tahun, currentMingguInfo.mingguKe);
  try { localStorage.setItem(key, JSON.stringify({ statusMingguan })); } catch(e) {}
}
function muatDraftMingguanLengkap(bulan, tahun, mingguKe) {
  try { const raw = localStorage.getItem(buatDraftKeyMingguan(bulan, tahun, mingguKe)); return raw ? JSON.parse(raw) : null; } catch(e) { return null; }
}
window.bersihkanDraftMingguan = function() {
  if (!currentMingguInfo) return;
  if (!confirm('Hapus draft yang belum disimpan untuk minggu ini?')) return;
  localStorage.removeItem(buatDraftKeyMingguan(currentMingguInfo.bulan, currentMingguInfo.tahun, currentMingguInfo.mingguKe));
  renderMingguanBaru();
};

function initMingguSelect() {
  const select = document.getElementById('mingguSelect');
  const bulan = parseInt(document.getElementById('bulanSelect').value);
  const tahun = parseInt(document.getElementById('tahunSelect').value);
  const weeks = getWeeksInMonth(bulan, tahun);
  select.innerHTML = weeks.map((w,i) => `<option value="${i}">Minggu ${i+1} (${formatDate(w.start)} - ${formatDate(w.end)})</option>`).join('');
}

window.renderMingguanBaru = function() {
  const mingguIdx = parseInt(document.getElementById('mingguSelect').value || 0);
  const bulan = parseInt(document.getElementById('bulanSelect').value);
  const tahun = parseInt(document.getElementById('tahunSelect').value);
  const weeks = getWeeksInMonth(bulan, tahun);
  const minggu = weeks[mingguIdx];
  if (!minggu) return;
  const hariList = getHariKerja(minggu);
  currentMingguInfo = { bulan, tahun, mingguKe: mingguIdx + 1, hariList, start: minggu.start, end: minggu.end };
  hariAktifCepatSet = hariList.length ? hariList[0].tanggal : null;
  document.getElementById('labelRentangMinggu').textContent = `📅 Minggu ${mingguIdx+1}: ${formatDateIndo(formatDate(minggu.start))} s/d ${formatDateIndo(formatDate(minggu.end))}`;

  statusMingguan = {};
  const draft = muatDraftMingguanLengkap(bulan, tahun, mingguIdx + 1);
  if (draft && draft.statusMingguan) {
    statusMingguan = JSON.parse(JSON.stringify(draft.statusMingguan));
  } else {
    guruData.absensi.forEach(a => {
      const d = new Date(a.tanggal);
      if (d >= minggu.start && d <= minggu.end && a.sumber === 'mingguan') {
        if (!statusMingguan[a.anakId]) statusMingguan[a.anakId] = {};
        statusMingguan[a.anakId][a.tanggal] = a.status;
      }
    });
  }
  renderCepatSetHari(hariList);
  renderGridMingguan(hariList);
  renderRiwayatMingguan();
};

function renderCepatSetHari(hariList) {
  const container = document.getElementById('cepatSetHari');
  container.innerHTML = hariList.map(h => `<button class="day-btn ${h.tanggal === hariAktifCepatSet ? 'active' : ''}" onclick="pilihHariAktif('${h.tanggal}', this)" style="min-width:60px;font-size:12px;padding:6px 10px;">${h.label}</button>`).join('');
}
window.pilihHariAktif = function(tanggal, btn) {
  hariAktifCepatSet = tanggal;
  document.querySelectorAll('#cepatSetHari .day-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
};
window.cepatSetSemuaAnakHariIni = function(status) {
  if (!hariAktifCepatSet) { alert('Pilih hari terlebih dahulu!'); return; }
  getAnakUrutTempat().forEach(anak => {
    if (!statusMingguan[anak.id]) statusMingguan[anak.id] = {};
    statusMingguan[anak.id][hariAktifCepatSet] = status;
  });
  simpanDraftMingguanLengkap();
  renderGridMingguan(currentMingguInfo.hariList);
};

function renderGridMingguan(hariList) {
  const container = document.getElementById('formMingguanGrid');
  const anakUrut = getAnakUrutTempat();
  if (anakUrut.length === 0) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:12px;text-align:center;">Belum ada data anak PKL.</p>'; return; }
  let html = ''; let lastTempat = '';
  anakUrut.forEach(anak => {
    const tempat = anak.tempatPkl || 'Tidak diketahui';
    if (tempat !== lastTempat) { html += `<div class="tempat-pkl-group">📍 ${tempat}</div>`; lastTempat = tempat; }
    if (!statusMingguan[anak.id]) statusMingguan[anak.id] = {};
    html += `<div class="mingguan-hari-row"><div class="nama-anak">${anak.nama}</div><div class="mingguan-status-group">`;
    hariList.forEach(h => {
      const st = statusMingguan[anak.id][h.tanggal] || 'belum';
      ['hadir','izin','alpa','libur'].forEach(s => {
        const aktif = st === s;
        const emoji = s === 'hadir' ? '✓' : s === 'izin' ? '📝' : s === 'alpa' ? '✗' : '🏖';
        html += `<button onclick="setStatusMingguan('${anak.id}','${h.tanggal}','${s}')" class="status-pill ${aktif ? getStatusClass(s) : 'status-belum'}" title="${h.label}: ${getStatusLabel(s)}" style="padding:4px 7px;font-size:11px;">${emoji}${aktif ? '' : ''}</button>`;
      });
    });
    html += `</div></div>`;
  });
  container.innerHTML = html;
}
window.setStatusMingguan = function(anakId, tanggal, status) {
  if (!statusMingguan[anakId]) statusMingguan[anakId] = {};
  statusMingguan[anakId][tanggal] = (statusMingguan[anakId][tanggal] === status) ? 'belum' : status;
  simpanDraftMingguanLengkap();
  renderGridMingguan(currentMingguInfo.hariList);
};

window.simpanSemuaMingguan = async function() {
  const entries = [];
  Object.keys(statusMingguan).forEach(anakId => {
    Object.keys(statusMingguan[anakId]).forEach(tanggal => {
      const status = statusMingguan[anakId][tanggal];
      if (status && status !== 'belum') entries.push({ anakId, tanggal, status });
    });
  });
  if (entries.length === 0) { alert('Belum ada data yang diisi untuk minggu ini.'); return; }
  const r = await api('saveMingguan', { password: guruPassword, entries });
  if (!r.ok) { alert('Gagal menyimpan: ' + (r.error||'')); return; }
  localStorage.removeItem(buatDraftKeyMingguan(currentMingguInfo.bulan, currentMingguInfo.tahun, currentMingguInfo.mingguKe));
  await loadGuruData();
  showTab('mingguan');
  alert(`✅ ${entries.length} data absen mingguan tersimpan!`);
};

function renderRiwayatMingguan() {
  const container = document.getElementById('riwayatMingguan');
  const grup = {};
  guruData.absensi.filter(a => a.sumber === 'mingguan').forEach(a => {
    if (!grup[a.tanggal]) grup[a.tanggal] = [];
    grup[a.tanggal].push(a);
  });
  const tanggalList = Object.keys(grup).sort().reverse();
  if (tanggalList.length === 0) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:12px;text-align:center;">Belum ada riwayat kunjungan.</p>'; return; }
  container.innerHTML = tanggalList.map(tgl => `
    <div style="padding:10px;border-radius:8px;background:var(--bg);border:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-size:13px;font-weight:600;">${formatDateIndo(tgl)}</div>
        <div style="font-size:11px;color:var(--accent);">✓ ${grup[tgl].length} data absen</div>
      </div>
      <button onclick="hapusKunjunganTanggal('${tgl}')" style="padding:4px 10px;border-radius:6px;background:var(--danger-soft);color:var(--danger);border:none;font-size:12px;">Hapus</button>
    </div>`).join('');
}

window.hapusKunjunganTanggal = async function(tgl) {
  if (!confirm('Yakin hapus semua data absen kunjungan pada tanggal ini?')) return;
  const ids = guruData.absensi.filter(a => a.sumber === 'mingguan' && a.tanggal === tgl).map(a => a.id);
  const r = await api('deleteAbsensiBulk', { password: guruPassword, ids });
  if (!r.ok) { alert('Gagal menghapus: ' + (r.error||'')); return; }
  await loadGuruData();
  showTab('mingguan');
};

// ============ RIWAYAT ============
function renderRiwayat() { renderRekapMingguan(); renderDetailRiwayat(); }
window.renderDashboard = renderDashboard;
window.renderRiwayat = renderRiwayat;

function renderRekapMingguan() {
  const container = document.getElementById('rekapMingguan');
  const bulan = parseInt(document.getElementById('bulanSelect').value);
  const tahun = parseInt(document.getElementById('tahunSelect').value);
  const filterSumber = document.getElementById('filterSumberRiwayat').value;
  const filterAnak = document.getElementById('filterAnak').value;
  const filterStatus = document.getElementById('filterStatus').value;
  const weeks = getWeeksInMonth(bulan, tahun);
  let anakUrut = getAnakUrutTempat();
  if (filterAnak !== 'semua') anakUrut = anakUrut.filter(a => a.id === filterAnak);
  if (anakUrut.length === 0) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:12px;text-align:center;">Tidak ada data anak yang cocok dengan filter</p>'; return; }

  let html = '<table style="width:100%;font-size:12px;border-collapse:collapse;min-width:600px;"><thead><tr style="color:var(--muted);">';
  html += '<th style="text-align:left;padding:8px;border-bottom:1px solid var(--border);">Nama</th><th style="text-align:left;padding:8px;border-bottom:1px solid var(--border);">Tempat PKL</th>';
  weeks.forEach((w,i) => html += `<th style="text-align:center;padding:8px;border-bottom:1px solid var(--border);">Mg ${i+1}</th>`);
  html += '<th style="text-align:center;padding:8px;border-bottom:1px solid var(--border);">Total</th></tr></thead><tbody>';

  anakUrut.forEach(anak => {
    html += `<tr><td style="padding:8px;border-bottom:1px solid var(--border);font-weight:500;">${anak.nama}</td><td style="padding:8px;border-bottom:1px solid var(--border);font-size:11px;color:var(--muted);">${anak.tempatPkl||'-'}</td>`;
    let tH=0,tI=0,tA=0,tL=0;
    weeks.forEach(w => {
      let absen = guruData.absensi.filter(a => { const d = new Date(a.tanggal); return a.anakId===anak.id && d>=w.start && d<=w.end && a.status !== 'pending'; });
      if (filterSumber !== 'semua') absen = absen.filter(a => a.sumber === filterSumber);
      if (filterStatus !== 'semua') absen = absen.filter(a => a.status === filterStatus);
      const h=absen.filter(a=>a.status==='hadir').length, i=absen.filter(a=>a.status==='izin').length, al=absen.filter(a=>a.status==='alpa').length, l=absen.filter(a=>a.status==='libur').length;
      tH+=h;tI+=i;tA+=al;tL+=l;
      let cell = '-';
      if (h+i+al+l>0) { cell = `<span style="color:var(--success);">${h}</span>`; if(i>0) cell+=` <span style="color:var(--warning);">${i}</span>`; if(al>0) cell+=` <span style="color:var(--danger);">${al}</span>`; if(l>0) cell+=` <span style="color:var(--libur);">${l}</span>`; }
      html += `<td style="text-align:center;padding:8px;border-bottom:1px solid var(--border);">${cell}</td>`;
    });
    html += `<td style="text-align:center;padding:8px;border-bottom:1px solid var(--border);font-weight:600;"><span style="color:var(--success);">${tH}</span> <span style="color:var(--warning);">${tI}</span> <span style="color:var(--danger);">${tA}</span> <span style="color:var(--libur);">${tL}</span></td></tr>`;
  });
  html += '</tbody></table><p style="font-size:11px;color:var(--muted);margin-top:8px;">Hijau=Hadir · Oranye=Izin · Merah=Alpa · Ungu=Libur</p>';
  container.innerHTML = html;
}

function renderDetailRiwayat() {
  const container = document.getElementById('detailRiwayat');
  const filterAnak = document.getElementById('filterAnak').value;
  const filterStatus = document.getElementById('filterStatus').value;
  const filterSumber = document.getElementById('filterSumberRiwayat').value;
  const bulan = parseInt(document.getElementById('bulanSelect').value);
  const tahun = parseInt(document.getElementById('tahunSelect').value);

  let riwayat = guruData.absensi.filter(a => { const d = new Date(a.tanggal); return d.getMonth()===bulan && d.getFullYear()===tahun; });
  if (filterAnak !== 'semua') riwayat = riwayat.filter(a => a.anakId === filterAnak);
  if (filterStatus !== 'semua') riwayat = riwayat.filter(a => a.status === filterStatus);
  if (filterSumber !== 'semua') riwayat = riwayat.filter(a => a.sumber === filterSumber);
  riwayat.sort((a,b) => (b.tanggal||'').localeCompare(a.tanggal||''));

  if (riwayat.length === 0) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:12px;text-align:center;">Tidak ada data</p>'; return; }
  container.innerHTML = riwayat.map(a => {
    const anak = cariAnak(a.anakId);
    const iconSumber = a.sumber === 'mingguan' ? '🗓️' : a.sumber === 'manual' ? '✍️' : '📱';
    const catatanAman = (a.catatanGuru || '').replace(/"/g, '&quot;');
    return `
      <div style="padding:8px 10px;border-radius:8px;background:var(--bg);border:1px solid var(--border);">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
          <div>
            <div style="font-size:13px;font-weight:500;">${iconSumber} ${anak ? anak.nama : '-'}</div>
            <div style="font-size:11px;color:var(--muted);">${formatDateIndo(a.tanggal)}${a.catatanGuru ? ' · ' + a.catatanGuru : ''}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="${getStatusClass(a.status)}" style="padding:2px 10px;border-radius:12px;font-size:11px;font-weight:500;">${getStatusLabel(a.status)}</span>
            <button onclick="toggleEditRiwayat('${a.id}')" title="Edit" style="padding:4px 8px;border-radius:6px;background:var(--info-soft);color:var(--info);border:none;font-size:12px;">✏️</button>
            <button onclick="hapusRiwayatItem('${a.id}')" title="Hapus" style="padding:4px 8px;border-radius:6px;background:var(--danger-soft);color:var(--danger);border:none;font-size:12px;">🗑️</button>
          </div>
        </div>
        <div id="editPanel_${a.id}" style="display:none;margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);flex-direction:column;gap:8px;">
          <select id="editStatus_${a.id}" class="input-field" style="font-size:13px;padding:6px;">
            <option value="hadir" ${a.status==='hadir'?'selected':''}>Hadir</option>
            <option value="izin" ${a.status==='izin'?'selected':''}>Izin</option>
            <option value="alpa" ${a.status==='alpa'?'selected':''}>Alpa</option>
            <option value="libur" ${a.status==='libur'?'selected':''}>Libur</option>
          </select>
          <input type="text" id="editCatatan_${a.id}" class="input-field" style="font-size:13px;padding:6px;" placeholder="Catatan (opsional)" value="${catatanAman}">
          <div style="display:flex;gap:6px;">
            <button onclick="simpanEditRiwayat('${a.id}')" class="btn-primary" style="padding:6px 12px;font-size:12px;flex:1;">Simpan</button>
            <button onclick="toggleEditRiwayat('${a.id}')" class="btn-secondary" style="padding:6px 12px;font-size:12px;">Batal</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

window.toggleEditRiwayat = function(id) {
  const panel = document.getElementById('editPanel_' + id);
  if (!panel) return;
  panel.style.display = (panel.style.display === 'flex') ? 'none' : 'flex';
};

window.simpanEditRiwayat = async function(id) {
  const status = document.getElementById('editStatus_' + id).value;
  const catatanGuru = document.getElementById('editCatatan_' + id).value.trim();
  const r = await api('reviewAbsen', { password: guruPassword, id, status, catatanGuru });
  if (!r.ok) { alert('Gagal menyimpan: ' + (r.error||'')); return; }
  await loadGuruData();
  showTab('riwayat');
};

window.hapusRiwayatItem = async function(id) {
  if (!confirm('Yakin hapus data absen ini? Tindakan ini tidak bisa dibatalkan.')) return;
  const r = await api('deleteAbsensiBulk', { password: guruPassword, ids: [id] });
  if (!r.ok) { alert('Gagal menghapus: ' + (r.error||'')); return; }
  await loadGuruData();
  showTab('riwayat');
};

// ============ DATA ANAK ============
function renderDaftarAnak() {
  const container = document.getElementById('daftarAnak');
  const anakUrut = getAnakUrutTempat();
  if (anakUrut.length === 0) { container.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:12px;text-align:center;">Belum ada data anak PKL.</p>'; return; }
  let html = ''; let lastTempat = '';
  anakUrut.forEach(anak => {
    const tempat = anak.tempatPkl || 'Tidak diketahui';
    if (tempat !== lastTempat) { html += `<div class="tempat-pkl-group">📍 ${tempat}</div>`; lastTempat = tempat; }
    html += `
      <div style="padding:12px;border-radius:10px;background:var(--bg);border:1px solid var(--border);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
          <div style="flex:1;min-width:200px;">
            <div style="font-weight:600;font-size:15px;">${anak.nama}</div>
            <div style="font-size:13px;color:var(--muted);margin-top:2px;">${anak.sekolah||'-'}${anak.kota?', '+anak.kota:''}${anak.jurusan?' · '+anak.jurusan:''}</div>
            ${anak.wa ? `<div style="font-size:12px;color:var(--muted);margin-top:2px;">WA: ${anak.wa}</div>` : ''}
            <div style="font-size:12px;color:var(--accent);margin-top:2px;">PIN: <strong>${anak.pin}</strong></div>
          </div>
          <div style="display:flex;gap:6px;">
            <button onclick='editAnak(${JSON.stringify(anak.id)})' style="padding:6px 12px;border-radius:6px;background:var(--accent-soft);color:var(--accent);border:none;font-size:12px;">Edit</button>
            <button onclick='hapusAnak(${JSON.stringify(anak.id)})' style="padding:6px 12px;border-radius:6px;background:var(--danger-soft);color:var(--danger);border:none;font-size:12px;">Hapus</button>
          </div>
        </div>
      </div>`;
  });
  container.innerHTML = html;
}

window.simpanAnak = async function() {
  const nama = document.getElementById('namaAnak').value.trim();
  const tempatPkl = document.getElementById('tempatPkl').value.trim();
  const sekolah = document.getElementById('sekolahAnak').value.trim();
  const kota = document.getElementById('kotaAnak').value.trim();
  const jurusan = document.getElementById('jurusanAnak').value.trim();
  const wa = document.getElementById('waAnak').value.trim();
  const pin = document.getElementById('pinAnak').value.trim();
  const editId = document.getElementById('editAnakId').value;
  if (!nama) { alert('Nama tidak boleh kosong!'); return; }
  if (!tempatPkl) { alert('Tempat PKL tidak boleh kosong!'); return; }

  const anak = { nama, tempatPkl, sekolah, kota, jurusan, wa, pin: pin || undefined };
  if (editId) anak.id = editId;
  const r = await api('saveAnak', { password: guruPassword, anak });
  if (!r.ok) { alert('Gagal menyimpan: ' + (r.error||'')); return; }
  bersihFormAnak();
  await loadGuruData();
  showTab('anak');
  alert(`Data anak tersimpan! PIN: ${r.pin}`);
};

window.editAnak = function(id) {
  const anak = cariAnak(id);
  if (!anak) return;
  document.getElementById('editAnakId').value = anak.id;
  document.getElementById('namaAnak').value = anak.nama || '';
  document.getElementById('tempatPkl').value = anak.tempatPkl || '';
  document.getElementById('sekolahAnak').value = anak.sekolah || '';
  document.getElementById('kotaAnak').value = anak.kota || '';
  document.getElementById('jurusanAnak').value = anak.jurusan || '';
  document.getElementById('waAnak').value = anak.wa || '';
  document.getElementById('pinAnak').value = anak.pin || '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.hapusAnak = async function(id) {
  if (!confirm('Yakin hapus? Semua data absen anak ini juga akan dihapus.')) return;
  const r = await api('deleteAnak', { password: guruPassword, id });
  if (!r.ok) { alert('Gagal menghapus: ' + (r.error||'')); return; }
  await loadGuruData();
  showTab('anak');
};

window.batalEditAnak = function() { bersihFormAnak(); };
function bersihFormAnak() {
  ['editAnakId','namaAnak','tempatPkl','sekolahAnak','kotaAnak','jurusanAnak','waAnak','pinAnak'].forEach(id => document.getElementById(id).value = '');
}

window.toggleBulk = function() { document.getElementById('bulkAccordion').classList.toggle('open'); };
window.bersihkanBulk = function() { document.getElementById('bulkInput').value = ''; document.getElementById('bulkResult').innerHTML = ''; };

window.prosesBulkInput = async function() {
  const text = document.getElementById('bulkInput').value.trim();
  if (!text) { alert('Isi data terlebih dahulu!'); return; }
  const baris = text.split('\n').filter(b => b.trim());
  const list = baris.map(b => {
    const bagian = b.split(',').map(x => x.trim());
    return { nama: bagian[0]||'', sekolah: bagian[1]||'', kota: bagian[2]||'', jurusan: bagian[3]||'', tempatPkl: bagian[4]||'', pin: bagian[5]||'' };
  });
  const UKURAN_KELOMPOK = 25;
  let semuaHasil = [];
  for (let i = 0; i < list.length; i += UKURAN_KELOMPOK) {
    const potongan = list.slice(i, i + UKURAN_KELOMPOK);
    const r = await api('bulkAddAnak', { password: guruPassword, list: potongan });
    if (!r.ok) { alert('Gagal: ' + (r.error||'')); return; }
    semuaHasil = semuaHasil.concat(r.results);
  }
  const berhasil = semuaHasil.filter(x => x.status === 'ok');
  const gagal = semuaHasil.filter(x => x.status !== 'ok');
  document.getElementById('bulkResult').innerHTML = `
    <p style="color:var(--accent);">✅ Berhasil: ${berhasil.length}</p>
    ${berhasil.length ? '<div style="font-family:monospace;font-size:11px;background:var(--bg);padding:8px;border-radius:6px;margin-top:6px;">' + berhasil.map(b => `${b.nama}: PIN ${b.pin}`).join('<br>') + '</div>' : ''}
    ${gagal.length ? `<p style="color:var(--danger);margin-top:6px;">❌ Gagal (nama/tempat kosong atau duplikat): ${gagal.map(g=>g.nama).join(', ')}</p>` : ''}
  `;
  if (berhasil.length > 0) document.getElementById('bulkInput').value = '';
  await loadGuruData();
};

window.toggleImportLama = function() { document.getElementById('importAccordion').classList.toggle('open'); };

window.prosesImportLama = async function() {
  const fileInput = document.getElementById('importFileInput');
  if (!fileInput.files[0]) { alert('Pilih file backup JSON dulu!'); return; }
  const resultEl = document.getElementById('importResult');
  resultEl.innerHTML = 'Membaca file…';
  try {
    const text = await fileInput.files[0].text();
    const data = JSON.parse(text);
    if (!data.anak) { resultEl.innerHTML = '<span style="color:var(--danger);">Format file tidak dikenali.</span>'; return; }

    // Kirim bertahap dalam kelompok kecil supaya tidak melebihi batas panjang URL.
    const UKURAN_KELOMPOK = 25;
    let totalAnak = 0, totalAbsensi = 0;
    const anakList = data.anak || [];
    const harianList = data.absenHarian || [];
    const mingguanList = data.absenMingguan || [];

    resultEl.innerHTML = 'Mengimpor data anak…';
    for (let i = 0; i < anakList.length; i += UKURAN_KELOMPOK) {
      const potongan = anakList.slice(i, i + UKURAN_KELOMPOK);
      const r = await api('importLama', { password: guruPassword, anak: potongan, absenHarian: [], absenMingguan: [] });
      if (!r.ok) { resultEl.innerHTML = '<span style="color:var(--danger);">Gagal import data anak: ' + (r.error||'') + '</span>'; return; }
      totalAnak += r.jumlahAnak;
    }

    resultEl.innerHTML = 'Mengimpor riwayat absen harian…';
    for (let i = 0; i < harianList.length; i += UKURAN_KELOMPOK) {
      const potongan = harianList.slice(i, i + UKURAN_KELOMPOK);
      const r = await api('importLama', { password: guruPassword, anak: [], absenHarian: potongan, absenMingguan: [] });
      if (!r.ok) { resultEl.innerHTML = '<span style="color:var(--danger);">Gagal import absen harian: ' + (r.error||'') + '</span>'; return; }
      totalAbsensi += r.jumlahAbsensi;
    }

    resultEl.innerHTML = 'Mengimpor riwayat absen mingguan…';
    for (let i = 0; i < mingguanList.length; i += UKURAN_KELOMPOK) {
      const potongan = mingguanList.slice(i, i + UKURAN_KELOMPOK);
      const r = await api('importLama', { password: guruPassword, anak: [], absenHarian: [], absenMingguan: potongan });
      if (!r.ok) { resultEl.innerHTML = '<span style="color:var(--danger);">Gagal import absen mingguan: ' + (r.error||'') + '</span>'; return; }
      totalAbsensi += r.jumlahAbsensi;
    }

    resultEl.innerHTML = `<span style="color:var(--accent);">✅ Berhasil import ${totalAnak} anak baru dan ${totalAbsensi} riwayat absen.</span>`;
    await loadGuruData();
    showTab('anak');
  } catch (e) {
    resultEl.innerHTML = '<span style="color:var(--danger);">File tidak valid: ' + e.message + '</span>';
  }
};

// ============ PENGATURAN ============
window.gantiPasswordGuru = async function() {
  const pwLama = document.getElementById('pwLama').value;
  const pwBaru = document.getElementById('pwBaru').value;
  const msgEl = document.getElementById('pwMsg');
  const r = await api('changeGuruPassword', { password: pwLama, newPassword: pwBaru });
  msgEl.style.display = 'block';
  if (r.ok) {
    msgEl.style.color = 'var(--success)';
    msgEl.textContent = '✅ Password berhasil diganti.';
    guruPassword = pwBaru;
    document.getElementById('pwLama').value = '';
    document.getElementById('pwBaru').value = '';
  } else {
    msgEl.style.color = 'var(--danger)';
    msgEl.textContent = '❌ ' + (r.error || 'Gagal mengganti password.');
  }
};

window.gantiKodeAksesGuru = async function() {
  const pw = document.getElementById('pwGuruUtkKode').value;
  const kodeBaru = document.getElementById('kodeAksesBaru').value;
  const msgEl = document.getElementById('kodeAksesMsg');
  const r = await api('gantiKodeAkses', { password: pw, kodeBaru });
  msgEl.style.display = 'block';
  if (r.ok) {
    msgEl.style.color = 'var(--success)';
    msgEl.textContent = '✅ Kode akses berhasil diganti. Sampaikan kode baru ini ke siswa.';
    document.getElementById('pwGuruUtkKode').value = '';
    document.getElementById('kodeAksesBaru').value = '';
  } else {
    msgEl.style.color = 'var(--danger)';
    msgEl.textContent = '❌ ' + (r.error || 'Gagal mengganti kode akses.');
  }
};

window.perbaikiUrlFotoLama = async function() {
  const msgEl = document.getElementById('perbaikiFotoMsg');
  msgEl.style.display = 'block';
  msgEl.style.color = 'var(--muted)';
  msgEl.textContent = 'Memperbaiki…';
  const r = await api('perbaikiUrlFoto', { password: guruPassword });
  if (r.ok) {
    msgEl.style.color = 'var(--success)';
    msgEl.textContent = `✅ ${r.jumlah} foto lama berhasil diperbaiki.`;
    await loadGuruData();
  } else {
    msgEl.style.color = 'var(--danger)';
    msgEl.textContent = '❌ ' + (r.error || 'Gagal memperbaiki.');
  }
};

window.exportData = function() {
  const dataStr = JSON.stringify(guruData, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `backup_absensi_pkl_${formatDate(new Date())}.json`; a.click();
  URL.revokeObjectURL(url);
};

// ============ PDF REKAP ============
window.downloadRekapPDF = function() {
  const bulan = parseInt(document.getElementById('bulanSelect').value);
  const tahun = parseInt(document.getElementById('tahunSelect').value);
  const filterSumber = document.getElementById('filterSumberDashboard').value;
  const namaBulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const weeks = getWeeksInMonth(bulan, tahun);
  const anakUrut = getAnakUrutTempat();
  const labelSumber = filterSumber === 'semua' ? 'Semua Sumber' : filterSumber === 'siswa' ? 'Kiriman Siswa' : filterSumber === 'mingguan' ? 'Kunjungan Mingguan' : 'Input Manual';

  let absenBulanIni = guruData.absensi.filter(a => { const d = new Date(a.tanggal); return d.getMonth()===bulan && d.getFullYear()===tahun && a.status !== 'pending'; });
  if (filterSumber !== 'semua') absenBulanIni = absenBulanIni.filter(a => a.sumber === filterSumber);

  const totalHadir = absenBulanIni.filter(a=>a.status==='hadir').length;
  const totalIzin = absenBulanIni.filter(a=>a.status==='izin').length;
  const totalAlpa = absenBulanIni.filter(a=>a.status==='alpa').length;
  const totalLibur = absenBulanIni.filter(a=>a.status==='libur').length;

  let html = `
    <h2>REKAP ABSENSI ANAK PKL</h2>
    <div class="sub">Periode: ${namaBulan[bulan]} ${tahun}<br>Filter: ${labelSumber}<br>Dicetak: ${formatDateIndo(formatDate(new Date()))}</div>
    <table>
      <tr><th>Total Hadir</th><th>Total Izin</th><th>Total Alpa</th><th>Total Libur</th><th>Jumlah Anak</th></tr>
      <tr>
        <td style="text-align:center;color:#297a2e;font-weight:600;">${totalHadir}</td>
        <td style="text-align:center;color:#d97706;font-weight:600;">${totalIzin}</td>
        <td style="text-align:center;color:#dc2626;font-weight:600;">${totalAlpa}</td>
        <td style="text-align:center;color:#7c3aed;font-weight:600;">${totalLibur}</td>
        <td style="text-align:center;font-weight:600;">${anakUrut.length}</td>
      </tr>
    </table>
    <h3 style="font-size:14px;margin:20px 0 8px 0;">Detail Rekap Per Minggu</h3>
  `;

  let headerTable = '<table><tr><th style="width:22%;">Nama</th><th style="width:18%;">Tempat PKL</th>';
  weeks.forEach((w,i) => headerTable += `<th style="text-align:center;">Mg ${i+1}</th>`);
  headerTable += '<th style="text-align:center;">Total</th></tr>';

  let lastTempat = '';
  anakUrut.forEach(anak => {
    const tempat = anak.tempatPkl || 'Tidak diketahui';
    if (tempat !== lastTempat) { if (lastTempat !== '') html += '</table>'; html += `<div class="tempat-group">📍 ${tempat}</div>`; html += headerTable; lastTempat = tempat; }
    let tH=0,tI=0,tA=0,tL=0;
    html += `<tr><td>${anak.nama}</td><td style="font-size:10px;color:#666;">${anak.sekolah||'-'}${anak.jurusan?' · '+anak.jurusan:''}</td>`;
    weeks.forEach(w => {
      let absen = absenBulanIni.filter(a => { const d = new Date(a.tanggal); return a.anakId===anak.id && d>=w.start && d<=w.end; });
      const h=absen.filter(a=>a.status==='hadir').length, i=absen.filter(a=>a.status==='izin').length, al=absen.filter(a=>a.status==='alpa').length, l=absen.filter(a=>a.status==='libur').length;
      tH+=h;tI+=i;tA+=al;tL+=l;
      let cell = '-';
      if (h+i+al+l>0) { cell = `<span style="color:#297a2e;">${h}</span>`; if(i>0) cell+=` <span style="color:#d97706;">${i}</span>`; if(al>0) cell+=` <span style="color:#dc2626;">${al}</span>`; if(l>0) cell+=` <span style="color:#7c3aed;">${l}</span>`; }
      html += `<td style="text-align:center;font-size:10px;">${cell}</td>`;
    });
    html += `<td style="text-align:center;font-weight:600;font-size:10px;"><span style="color:#297a2e;">${tH}</span> <span style="color:#d97706;">${tI}</span> <span style="color:#dc2626;">${tA}</span> <span style="color:#7c3aed;">${tL}</span></td></tr>`;
  });
  if (lastTempat !== '') html += '</table>';
  html += `<div style="margin-top:20px;font-size:10px;color:#666;border-top:1px solid #ccc;padding-top:8px;"><strong>Keterangan:</strong><br>H = Hadir &nbsp; I = Izin &nbsp; A = Alpa &nbsp; L = Libur</div>`;

  const printArea = document.getElementById('printArea');
  printArea.innerHTML = html;
  printArea.style.display = 'block';
  setTimeout(() => { window.print(); setTimeout(() => { printArea.style.display = 'none'; }, 500); }, 250);
};
})();
