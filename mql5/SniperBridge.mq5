//+------------------------------------------------------------------+
//|                                                  SniperBridge.mq5 |
//| sisi terminal dari FX Multi Scanner bridge                         |
//|                                                                   |
//| Protokol file (MQL5/Files/, ANSI, baris "k=v;k=v;...;end=1"):      |
//|   sniper_req.txt    bridge -> EA  cmd=PING|BUY|SELL|HALT|RESUME|  |
//|                                   CLOSEALL                        |
//|                                   id=..;symbol=..;volume=..;      |
//|                                   price=..;sl=..;tp1=..;tp2=..    |
//|   sniper_ack.txt    EA -> bridge  id=..;ok=1|0;ticket=..;reason=..|
//|   sniper_status.txt EA -> bridge  akun, posisi, realized hari ini,|
//|                                   spread/harga per simbol, halt   |
//|   sniper_pos.txt    EA -> sendiri state posisi (pulih dr restart) |
//|   sniper_trades.txt EA -> bridge  deal PENUTUPAN milik EA ini;     |
//|                                   dibuat walau masih kosong —      |
//|                                   berkas tidak ada = build lama    |
//|   sniper_bars.txt   EA -> bridge  bar 1 menit broker per simbol,   |
//|                                   buat warm-up scanner di bridge   |
//|   sniper_lastid.txt EA -> sendiri id permintaan terakhir          |
//|                                                                   |
//| EA ini OTORITAS GUARD. Semua angka dari bridge diperiksa ulang    |
//| terhadap kondisi akun nyata: bridge bisa basi, salah hitung, atau  |
//| dibajak file. Order tidak boleh jadi hanya karena file menyuruh.   |
//| Eksekusi hanya terjadi kalau kamu sendiri yang memasang EA ini ke  |
//| chart DEMO dan menyalakan Algo Trading.                           |
//+------------------------------------------------------------------+
#property copyright "sniperbridge"
#property version   "1.00"

#include <Trade\Trade.mqh>

input long     InMagic           = 575100;  // magic number EA ini
input bool     InAllowLive       = false;   // false = TOLAK akun real (demo only)
input string   InSymbols         = "EURUSD,USDJPY,GBPUSD,USDCHF,AUDUSD,USDCAD,NZDUSD,XAUUSD,BTCUSD,ETHUSD";
input double   InRiskPct         = 3.0;     // % ekuitas per trade — lot diminta tidak akan pernah melebihi ini
input double   InMaxLot          = 0.10;    // plafon lot absolut
input int      InMaxPositions    = 5;       // maksimum posisi terbuka milik EA ini
input double   InMaxTotalRiskUsd = 100.0;   // plafon jumlah risiko (USD) semua posisi terbuka
input double   InMaxDailyLossUsd = 50.0;    // realized hari ini <= -X -> berhenti hari itu
input double   InProfitTargetUsd = 100.0;   // realized hari ini >= +X -> berhenti hari itu (cap, bukan dikejar)
input double   InMinEquityUsd    = 0.0;     // equity di bawah ini -> HALT permanen (0 = nonaktif)
input double   InMinMarginFreeUsd= 50.0;    // margin free minimum untuk order baru
input int      InMaxSpreadPoints = 30;      // spread maksimum (points broker, lantai untuk FX)
input double   InMaxSpreadAtrPct = 25.0;    // % ATR: 25 ⇒ ATR/spread ≥ 4× (selaras minCost engine/bridge; dulu 15% = zona mati 2.4–6.7×)
input int      InMaxPriceDriftPts= 15;      // jarak harga sekarang vs entry yang diminta (points, floor)
input double   InMaxDriftPct     = 0.02;    // ... atau % dari harga (0 = pakai points saja)
input int      InMaxHoldMin      = 0;       // time-stop (0 = nonaktif, biarkan tren & SMC berkembang)
input int      InSlippagePoints  = 10;
input double   InTP1Fraction     = 0.5;     // 50% ditutup di TP1 (model yang sama dengan backtest)
input double   InBeAtR           = 1.0;     // SL geser ke entry setelah +1.0R (auto-breakeven risk-free)
input ENUM_TIMEFRAMES InAtrTF    = PERIOD_M15; // timeframe ATR yang dilaporkan ke bridge
input int      InTimerSec        = 1;
input int      InStatsDays       = 30;     // jendela statistik trade tertutup (hari)
input int      InStatsMax        = 300;    // maksimum baris yang ditulis ke sniper_trades.txt
input int      InStatsBars       = 270;    // bar 1 menit per simbol ke sniper_bars.txt (0 = nonaktif)

//--- BTS STRATEGY (CCI 45 + EMA 200 - Ahmad 12fx System)
input bool     InUseBTS          = true;    // Izinkan sinyal BTS Strategy
input int      InCCIPeriod       = 45;      // Periode CCI (Median HL/2)
input double   InCCILevelBuy     = -190.0;  // Level Oversold Buy
input double   InCCILevelSell    = 100.0;   // Level Overbought Sell
input int      InBTSEMAPeriod    = 200;     // Periode EMA konfirmasi

CTrade trade;

ulong    g_ticket[];
double   g_entry[], g_rdist[], g_tp1[], g_tp2[];
bool     g_tp1Done[];
datetime g_openAt[];

long     g_lastId     = -1;
string   g_halt       = "";
bool     g_haltPerm   = false;
datetime g_haltDay    = 0;
string   g_tradesCache = "";
bool     g_tradesSeen  = false;   // sudah pernah menulis sniper_trades.txt sekali (boleh kosong)
uint     g_tradesTick  = 0;
datetime g_tzOff       = -999999; // selisih clock server/GMT, dihitung sekali (lihat TzOffset)
string   g_barsCache   = "";

//+------------------------------------------------------------------+
void OnInit()
{
   trade.SetExpertMagicNumber(InMagic);
   trade.SetDeviationInPoints(InSlippagePoints);
   trade.SetAsyncMode(false);
   g_haltDay = DayStartUTC();
   LoadPos();
   LoadLastId();
   EventSetTimer(InTimerSec <= 0 ? 1 : InTimerSec);
   Print("SniperBridge mulai — demo-only=", (!InAllowLive ? "YA" : "TIDAK"),
         " cap=$", DoubleToString(InProfitTargetUsd, 2),
         " batas-rugi=$", DoubleToString(InMaxDailyLossUsd, 2),
         " akun=", AccountInfoString(ACCOUNT_SERVER), " (", AccountInfoInteger(ACCOUNT_LOGIN), ")");
}

void OnDeinit(const int reason) { EventKillTimer(); SavePos(); SaveLastId(); }
void OnTick()                   { Step(); }
void OnTimer()                  { Step(); }

void Step()
{
   RollDay();
   ManagePositions();
   CheckPendingOCO();
   ProcessReq();
   WriteStatus();
   WriteTrades();
   WriteBars();
}

void CancelPending(const string sym)
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong tk = OrderGetTicket(i);
      if(tk == 0) continue;
      if(OrderGetInteger(ORDER_MAGIC) != InMagic) continue;
      if(sym != "" && OrderGetString(ORDER_SYMBOL) != sym) continue;
      trade.OrderDelete(tk);
      Print("SniperBridge Cancelled Pending Order #", IntegerToString(tk), " for ", sym);
   }
}

void CheckPendingOCO()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) == InMagic)
      {
         string sym = PositionGetString(POSITION_SYMBOL);
         CancelPending(sym);
      }
   }
}

//+------------------------------------------------------------------+
//| helper file "k=v;k=v;end=1"                                       |
//+------------------------------------------------------------------+
string Field(const string &parts[], const string key)
{
   for(int i = 0; i < ArraySize(parts); i++)
   {
      int eq = StringFind(parts[i], "=");
      if(eq < 0) continue;
      if(StringSubstr(parts[i], 0, eq) == key) return StringSubstr(parts[i], eq + 1);
   }
   return "";
}

// baris terakhir yang benar-benar utuh (punya end=1) — toleran terhadap file separuh tulis
bool ReadLastLine(const string fname, string &out)
{
   int h = FileOpen(fname, FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return false;
   bool got = false;
   while(!FileIsEnding(h))
   {
      string s = FileReadString(h);
      if(StringLen(s) > 6 && StringFind(s, "end=1") >= 0) { out = s; got = true; }
   }
   FileClose(h);
   return got;
}

void Rewrite(const string fname, const string content)
{
   int h = FileOpen(fname, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   if(StringLen(content) > 0) FileWriteString(h, content);
   FileFlush(h);
   FileClose(h);
}

void AppendLine(const string fname, const string line)
{
   int h = FileOpen(fname, FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) h = FileOpen(fname, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, line + "\n");
   FileFlush(h);
   FileClose(h);
}

//+------------------------------------------------------------------+
//| kondisi akun                                                      |
//+------------------------------------------------------------------+
bool IsDemo() { return AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO; }

int SymCount() { string a[]; return StringSplit(InSymbols, ',', a); }
string SymAt(const int i)
{
   string a[];
   int n = StringSplit(InSymbols, ',', a);
   return (i >= 0 && i < n) ? a[i] : "";
}

datetime DayStartUTC()
{
   MqlDateTime dt;
   TimeToStruct(TimeGMT(), dt);
   dt.hour = 0; dt.min = 0; dt.sec = 0;
   return StructToTime(dt);
}

// ganti hari UTC: halt harian dibersihkan, halt permanen (floor equity) tidak
void RollDay()
{
   datetime d = DayStartUTC();
   if(d == g_haltDay) return;
   g_haltDay = d;
   if(!g_haltPerm) g_halt = "";
}

void SetHalt(const string why, const bool perm)
{
   if(perm) g_haltPerm = true;
   if(g_halt == "") g_halt = why;
}

double PointOf(const string sym)
{
   double p = SymbolInfoDouble(sym, SYMBOL_POINT);
   return p > 0 ? p : Point();
}

// nilai 1 point untuk 1 lot, dalam mata uang akun
double PointValuePerLot(const string sym)
{
   double tickVal  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   double p        = PointOf(sym);
   if(tickVal <= 0 || tickSize <= 0 || p <= 0) return 0;
   return tickVal * p / tickSize;
}

// realisasi USD (profit+swap+komisi) deal OUT milik EA ini sejak `from`
double RealizedSince(const datetime from)
{
   double sum = 0;
   if(!HistorySelect(from, TimeCurrent() + 60)) return 0;
   int n = HistoryDealsTotal();
   for(int i = 0; i < n; i++)
   {
      ulong tk = HistoryDealGetTicket(i);
      if(tk == 0) continue;
      if(HistoryDealGetInteger(tk, DEAL_MAGIC) != InMagic) continue;
      long e = HistoryDealGetInteger(tk, DEAL_ENTRY);
      if(e != DEAL_ENTRY_OUT && e != DEAL_ENTRY_OUT_BY && e != DEAL_ENTRY_INOUT) continue;
      sum += HistoryDealGetDouble(tk, DEAL_PROFIT) + HistoryDealGetDouble(tk, DEAL_SWAP) + HistoryDealGetDouble(tk, DEAL_COMMISSION);
   }
   return sum;
}

/* TimeCurrent() hanya bergerak saat tick masuk, TimeGMT() terus berjalan: selisihnya berkedip
   ±20 dtk. Dulu dihitung per-panggil, jadi (a) t= di sniper_trades.txt berubah untuk trade yang
   sudah lama tertutup -> cache tidak pernah cocok -> berkas ditulis ulang tiap 5 dtk selamanya,
   dan (b) batas "hari ini" di RealizedToday ikut bergeser. Ambilan pertama yang sah dipakai terus. */
datetime TzOffset()
{
   if(g_tzOff != -999999) return g_tzOff;
   datetime sc = TimeCurrent(), gm = TimeGMT();
   if(sc == 0 || gm == 0) return 0;
   g_tzOff = sc - gm;
   return g_tzOff;
}

double RealizedToday() { return RealizedSince(g_haltDay + TzOffset()); }

int MyPositions()
{
   int c = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) == InMagic) c++;
   }
   return c;
}

// risiko = jarak SL (dalam point) x nilai point/lot x volume
double OpenRiskOf(const ulong tk)
{
   if(!PositionSelectByTicket(tk)) return 0;
   string sym = PositionGetString(POSITION_SYMBOL);
   int i = IndexOf(tk);
   double rdist = i >= 0 ? g_rdist[i] : MathAbs(PositionGetDouble(POSITION_PRICE_OPEN) - PositionGetDouble(POSITION_SL));
   double p = PointOf(sym);
   if(p <= 0 || rdist <= 0) return 0;
   return (rdist / p) * PointValuePerLot(sym) * PositionGetDouble(POSITION_VOLUME);
}

double TotalOpenRiskUsd()
{
   double r = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InMagic) continue;
      r += OpenRiskOf(tk);
   }
   return r;
}

int IndexOf(const ulong tk)
{
   for(int i = 0; i < ArraySize(g_ticket); i++) if(g_ticket[i] == tk) return i;
   return -1;
}

//+------------------------------------------------------------------+
//| guard: "" = boleh order baru                                      |
//+------------------------------------------------------------------+
string GuardNewOrder(const string sym)
{
   if(!InAllowLive && !IsDemo()) return "AKUN REAL — EA ini demo-only (InAllowLive=false, ubah sadar-sadar)";
   if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)) return "trading/algo tidak diizinkan terminal";
   if(!AccountInfoInteger(ACCOUNT_TRADE_EXPERT)) return "expert trading tidak diizinkan broker";
   if(g_haltPerm) return "HALT permanen: " + g_halt;
   if(g_halt != "") return "HALT hari ini: " + g_halt;

   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(InMinEquityUsd > 0 && eq < InMinEquityUsd)
      return "equity $" + DoubleToString(eq, 2) + " < floor $" + DoubleToString(InMinEquityUsd, 2);

   double real = RealizedToday();
   if(InProfitTargetUsd > 0 && real >= InProfitTargetUsd)
      return "cap +$" + DoubleToString(InProfitTargetUsd, 2) + " tercapai (realized $" + DoubleToString(real, 2) + ") — berhenti hari ini";
   if(InMaxDailyLossUsd > 0 && real <= -InMaxDailyLossUsd)
      return "batas rugi harian -$" + DoubleToString(InMaxDailyLossUsd, 2) + " tersentuh (realized $" + DoubleToString(real, 2) + ")";

   if(MyPositions() >= InMaxPositions) return "maksimum " + IntegerToString(InMaxPositions) + " posisi";
   double used = TotalOpenRiskUsd();
   if(InMaxTotalRiskUsd > 0 && used >= InMaxTotalRiskUsd)
      return "risiko terbuka $" + DoubleToString(used, 2) + " >= plafon $" + DoubleToString(InMaxTotalRiskUsd, 2);
   double mf = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   if(mf < InMinMarginFreeUsd) return "margin free $" + DoubleToString(mf, 2) + " < $" + DoubleToString(InMinMarginFreeUsd, 2);

   for(int i = 0; i < ArraySize(g_ticket); i++)
      if(PositionSelectByTicket(g_ticket[i]) && PositionGetString(POSITION_SYMBOL) == sym)
         return "sudah ada posisi " + sym + " milik EA ini";
   if(PositionSelect(sym)) return "sudah ada posisi " + sym + " (bukan milik EA ini) — tidak menimpa posisi asing";
   return "";
}

//+------------------------------------------------------------------+
//| permintaan masuk                                                  |
//+------------------------------------------------------------------+
void ProcessReq()
{
   string line;
   if(!ReadLastLine("sniper_req.txt", line)) return;
   string parts[];
   StringSplit(line, ';', parts);
   long id = (long)StringToInteger(Field(parts, "id"));
   string cmd = Field(parts, "cmd");
   if(id == g_lastId) { Rewrite("sniper_req.txt", ""); return; }

   g_lastId = id;
   SaveLastId();

   if(cmd == "PING")       { Ack(id, true, 0, "pong"); Rewrite("sniper_req.txt", ""); return; }
   if(cmd == "HALT")       { SetHalt(Field(parts, "why"), false); Ack(id, true, 0, "halt"); Rewrite("sniper_req.txt", ""); return; }
   if(cmd == "RESUME")     { if(!g_haltPerm) { g_halt = ""; } Ack(id, !g_haltPerm, 0, g_haltPerm ? "halt permanen, pakai RESET di parameter" : "resume"); Rewrite("sniper_req.txt", ""); return; }
   if(cmd == "CLOSEALL")   { CloseAll(); Ack(id, true, 0, "closeall"); Rewrite("sniper_req.txt", ""); return; }
   if(cmd == "CANCEL" || cmd == "CANCEL_PENDING")
   {
      CancelPending(Field(parts, "symbol"));
      Ack(id, true, 0, "cancel_pending");
      Rewrite("sniper_req.txt", "");
      return;
   }
   if(cmd == "BUY" || cmd == "SELL" || cmd == "BUY_STOP" || cmd == "SELL_STOP" || cmd == "BUY_LIMIT" || cmd == "SELL_LIMIT")
   {
      DoOrder(id, cmd, Field(parts, "symbol"), StringToDouble(Field(parts, "volume")),
              StringToDouble(Field(parts, "price")), StringToDouble(Field(parts, "sl")),
              StringToDouble(Field(parts, "tp1")), StringToDouble(Field(parts, "tp2")),
              StringToDouble(Field(parts, "riskusd")));
      Rewrite("sniper_req.txt", "");
      return;
   }
   Ack(id, false, 0, "cmd tidak dikenal: " + cmd);
   Rewrite("sniper_req.txt", "");
}

void Ack(const long id, const bool ok, const ulong ticket, const string reason)
{
   AppendLine("sniper_ack.txt", "end=1;id=" + IntegerToString(id) + ";ok=" + (ok ? "1" : "0") +
              ";ticket=" + IntegerToString(ticket) + ";reason=" + reason +
              ";ts=" + IntegerToString((long)TimeGMT()));
}

//+------------------------------------------------------------------+
//| order market & pending (Straddle/Limit), SL+TP dikirim sekaligus  |
//+------------------------------------------------------------------+
void DoOrder(const long id, const string cmd, const string sym, const double volReq, const double priceReq,
             const double slReq, const double tp1Req, const double tp2Req, const double riskReq)
{
   string why = GuardNewOrder(sym);
   if(why != "") { Ack(id, false, 0, why); return; }

   if(sym == "") { Ack(id, false, 0, "symbol kosong"); return; }
   if(!SymbolSelect(sym, true)) { Ack(id, false, 0, "simbol tidak ada di Market Watch"); return; }
   if(SymbolInfoInteger(sym, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_DISABLED) { Ack(id, false, 0, "perdagangan simbol di-disable broker"); return; }

   bool isPending = (cmd == "BUY_STOP" || cmd == "SELL_STOP" || cmd == "BUY_LIMIT" || cmd == "SELL_LIMIT");
   bool buy = (cmd == "BUY" || cmd == "BUY_STOP" || cmd == "BUY_LIMIT");

   double point = PointOf(sym);
   int digits   = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double ask   = SymbolInfoDouble(sym, SYMBOL_ASK), bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double px    = isPending ? priceReq : (buy ? ask : bid);
   if(px <= 0 || point <= 0) { Ack(id, false, 0, "harga tidak valid"); return; }

   if(!isPending)
   {
      double driftPts = MathAbs(px - priceReq) / point;
      /* sama seperti spread: 15 points = $0.15 di BTC/ETH, dan itu lebih kecil dari satu denyut
         harga — order yang sah akan selalu dituduh "harga sudah lari". plafon = floor points
         ATAU sebagian kecil dari harga, mana yang lebih longgar. */
      double driftCap  = (InMaxDriftPct > 0.0 && px > 0.0)
                         ? MathMax((double)InMaxPriceDriftPts, px * InMaxDriftPct / 100.0 / point)
                         : (double)InMaxPriceDriftPts;
      if(InMaxPriceDriftPts > 0 && driftPts > driftCap)
      { Ack(id, false, 0, "harga sudah lari " + DoubleToString(driftPts, 1) + " pts (maks " + DoubleToString(driftCap, 0) + ") dari entry yang diminta — jangan kejar"); return; }
   }

   double spreadPts = (ask - bid) / point;
   /* "30 points" tidak punya arti lintas broker: point BTC/ETH di FBS 0.01, jadi spread
      normal 1965 pts (BTC) sudah melebihi 30 dan semua order crypto mati. plafon diambil
      dari volatilitas simbol itu sendiri — InMaxSpreadPoints tetap jadi lantai untuk FX. */
   double atrPts    = AtrPoints(sym);
   double sprCap    = (atrPts > 0.0 && InMaxSpreadAtrPct > 0.0)
                      ? MathMax((double)InMaxSpreadPoints, atrPts * InMaxSpreadAtrPct / 100.0)
                      : (double)InMaxSpreadPoints;
   if(spreadPts > sprCap)
   { Ack(id, false, 0, "spread " + DoubleToString(spreadPts, 0) + " > " + DoubleToString(sprCap, 0) + " pts (" + DoubleToString(InMaxSpreadAtrPct, 1) + "% ATR " + DoubleToString(atrPts, 0) + ")"); return; }

   double stops = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * point;
   if(slReq <= 0) { Ack(id, false, 0, "permintaan tanpa SL ditolak"); return; }
   if(tp2Req <= 0) { Ack(id, false, 0, "permintaan tanpa TP ditolak"); return; }

   if(isPending)
   {
      if(cmd == "BUY_STOP" && priceReq <= ask + stops) { Ack(id, false, 0, "Buy Stop harus di atas Ask + stops"); return; }
      if(cmd == "SELL_STOP" && priceReq >= bid - stops) { Ack(id, false, 0, "Sell Stop harus di bawah Bid - stops"); return; }
      if(cmd == "BUY_LIMIT" && priceReq >= ask - stops) { Ack(id, false, 0, "Buy Limit harus di bawah Ask - stops"); return; }
      if(cmd == "SELL_LIMIT" && priceReq <= bid + stops) { Ack(id, false, 0, "Sell Limit harus di atas Bid + stops"); return; }
   }
   else
   {
      // jangan pernah menggeser SL/TP diam-diam: terlalu dekat = tolak, bukan lebarkan risiko
      if(buy  && (slReq >= px - stops || tp2Req <= px + stops)) { Ack(id, false, 0, "SL/TP terlalu dekat dengan harga (stops level broker)"); return; }
      if(!buy && (slReq <= px + stops || tp2Req >= px - stops)) { Ack(id, false, 0, "SL/TP terlalu dekat dengan harga (stops level broker)"); return; }
   }
   if((buy && tp2Req <= px) || (!buy && tp2Req >= px)) { Ack(id, false, 0, "TP di sisi yang salah"); return; }

   double sl = slReq, tp = tp2Req, rdist = MathAbs(px - sl);
   if(rdist <= 0) { Ack(id, false, 0, "jarak SL nol"); return; }

   // Lot dihitung DI SINI, bukan oleh bridge. volume=0 berarti "hitung dari risiko";
   // riskusd yang diminta bridge selalu dijepit oleh InRiskPct terminal ini, dan
   // tidak pernah dinaikkan di atas permintaan — hanya boleh diperkecil.
   double pv = PointValuePerLot(sym);
   double perLotRisk = pv > 0 ? (rdist / point) * pv : 0;   // USD risiko untuk 1 lot
   double capUsd  = AccountInfoDouble(ACCOUNT_EQUITY) * InRiskPct / 100.0;
   double wantUsd = riskReq > 0 ? MathMin(riskReq, capUsd) : capUsd;
   double roomUsd = InMaxTotalRiskUsd > 0 ? MathMax(0.0, InMaxTotalRiskUsd - TotalOpenRiskUsd()) : wantUsd;
   double vmin  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double vstep = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double v = volReq;
   if(perLotRisk > 0)
   {
      double byUsd = MathMin(wantUsd, roomUsd) / perLotRisk;
      v = (v > 0) ? MathMin(v, byUsd) : byUsd;
   }
   if(vstep > 0) v = MathFloor(v / vstep + 1e-9) * vstep;
   // Jika volume yang diminta memenuhi lot minimum broker, izinkan eksekusi minimum lot
   if(v < vmin && volReq >= vmin)
   {
      v = vmin;
   }
   if(v <= 0) { Ack(id, false, 0, "ruang risiko tidak cukup untuk membuka posisi"); return; }
   if(InMaxLot > 0 && v > InMaxLot) v = InMaxLot;
   if(v < vmin) { Ack(id, false, 0, "saldo tidak cukup untuk lot minimum " + DoubleToString(vmin, 2) + " di " + sym); return; }
   if(v > vmax) v = vmax;

   double margin = 0;
   ENUM_ORDER_TYPE orderType = buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(cmd == "BUY_STOP") orderType = ORDER_TYPE_BUY_STOP;
   else if(cmd == "SELL_STOP") orderType = ORDER_TYPE_SELL_STOP;
   else if(cmd == "BUY_LIMIT") orderType = ORDER_TYPE_BUY_LIMIT;
   else if(cmd == "SELL_LIMIT") orderType = ORDER_TYPE_SELL_LIMIT;

   if(!OrderCalcMargin(orderType, sym, v, px, margin)) { Ack(id, false, 0, "OrderCalcMargin gagal"); return; }
   if(margin > AccountInfoDouble(ACCOUNT_MARGIN_FREE) * 0.8)
   { Ack(id, false, 0, "margin " + DoubleToString(margin, 2) + " > 80% margin free " + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2)); return; }

   trade.SetTypeFillingBySymbol(sym);
   bool ok = false;
   if(cmd == "BUY") ok = trade.Buy(v, sym, 0.0, sl, tp, "SNIPER");
   else if(cmd == "SELL") ok = trade.Sell(v, sym, 0.0, sl, tp, "SNIPER");
   else if(cmd == "BUY_STOP") ok = trade.BuyStop(v, px, sym, sl, tp, ORDER_TIME_GTC, 0, "SNIPER_STRADDLE");
   else if(cmd == "SELL_STOP") ok = trade.SellStop(v, px, sym, sl, tp, ORDER_TIME_GTC, 0, "SNIPER_STRADDLE");
   else if(cmd == "BUY_LIMIT") ok = trade.BuyLimit(v, px, sym, sl, tp, ORDER_TIME_GTC, 0, "SNIPER_LIMIT");
   else if(cmd == "SELL_LIMIT") ok = trade.SellLimit(v, px, sym, sl, tp, ORDER_TIME_GTC, 0, "SNIPER_LIMIT");

   if(!ok) { Ack(id, false, 0, "order ditolak server (retcode " + IntegerToString(trade.ResultRetcode()) + ")"); return; }

   if(isPending)
   {
      ulong orderTk = trade.ResultOrder();
      Ack(id, true, orderTk, "ok pending " + cmd + " vol=" + DoubleToString(v, 2) + " sl=" + DoubleToString(sl, digits) + " tp=" + DoubleToString(tp, digits));
      Print("SniperBridge PENDING ", cmd, " ", sym, " ", v, " @", px, " SL ", sl, " TP2 ", tp);
   }
   else
   {
      ulong posTk = OpenedPositionId();
      if(posTk == 0) posTk = trade.ResultOrder();
      Track(posTk, px, sl, tp1Req, tp2Req);
      SavePos(); SaveLastId();
      Ack(id, true, posTk, "ok vol=" + DoubleToString(v, 2) + " sl=" + DoubleToString(sl, digits) + " tp=" + DoubleToString(tp, digits));
      Print("SniperBridge ", (buy ? "BUY " : "SELL "), sym, " ", v, " @", px, " SL ", sl, " TP2 ", tp, " TP1 ", tp1Req);
   }
}

ulong OpenedPositionId()
{
   if(!HistorySelect(TimeCurrent() - 600, TimeCurrent() + 60)) return 0;
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
   {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0) continue;
      if(HistoryDealGetInteger(d, DEAL_MAGIC) != InMagic) continue;
      if(HistoryDealGetInteger(d, DEAL_ENTRY) != DEAL_ENTRY_IN) continue;
      ulong pid = (ulong)HistoryDealGetInteger(d, DEAL_POSITION_ID);
      if(pid > 0) return pid;
   }
   return 0;
}

//+------------------------------------------------------------------+
void Track(const ulong posTk, const double entry, const double sl, const double tp1, const double tp2)
{
   int i = ArraySize(g_ticket);
   ArrayResize(g_ticket, i + 1);  ArrayResize(g_entry, i + 1);  ArrayResize(g_rdist, i + 1);
   ArrayResize(g_tp1, i + 1);     ArrayResize(g_tp2, i + 1);    ArrayResize(g_tp1Done, i + 1);
   ArrayResize(g_openAt, i + 1);
   g_ticket[i] = posTk; g_entry[i] = entry; g_rdist[i] = MathAbs(entry - sl);
   g_tp1[i] = tp1;    g_tp2[i] = tp2;     g_tp1Done[i] = false; g_openAt[i] = TimeCurrent();
}

void Untrack(const ulong tk)
{
   int i = IndexOf(tk);
   if(i < 0) return;
   int last = ArraySize(g_ticket) - 1;
   g_ticket[i] = g_ticket[last];   g_entry[i] = g_entry[last];   g_rdist[i] = g_rdist[last];
   g_tp1[i] = g_tp1[last];         g_tp2[i] = g_tp2[last];       g_tp1Done[i] = g_tp1Done[last];
   g_openAt[i] = g_openAt[last];
   ArrayResize(g_ticket, last);    ArrayResize(g_entry, last);   ArrayResize(g_rdist, last);
   ArrayResize(g_tp1, last);       ArrayResize(g_tp2, last);     ArrayResize(g_tp1Done, last);
   ArrayResize(g_openAt, last);
}

void SavePos()
{
   string s = "";
   for(int i = 0; i < ArraySize(g_ticket); i++)
      s += "tk=" + IntegerToString(g_ticket[i]) + ";entry=" + DoubleToString(g_entry[i], 8) +
           ";rdist=" + DoubleToString(g_rdist[i], 8) + ";tp1=" + DoubleToString(g_tp1[i], 8) +
           ";tp2=" + DoubleToString(g_tp2[i], 8) + ";p1=" + (g_tp1Done[i] ? "1" : "0") +
           ";open=" + IntegerToString((long)g_openAt[i]) + "\n";
   Rewrite("sniper_pos.txt", s);
}

void LoadPos()
{
   int h = FileOpen("sniper_pos.txt", FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   while(!FileIsEnding(h))
   {
      string line = FileReadString(h);
      if(StringLen(line) < 8) continue;
      string p[];
      StringSplit(line, ';', p);
      ulong tk = (ulong)StringToInteger(Field(p, "tk"));
      double entry = StringToDouble(Field(p, "entry")), rdist = StringToDouble(Field(p, "rdist"));
      if(tk == 0 || entry <= 0 || rdist <= 0 || IndexOf(tk) >= 0) continue;
      Track(tk, entry, entry - rdist, StringToDouble(Field(p, "tp1")), StringToDouble(Field(p, "tp2")));
      int i = IndexOf(tk);
      g_tp1Done[i] = (Field(p, "p1") == "1");
      g_openAt[i]  = (datetime)StringToInteger(Field(p, "open"));
   }
   FileClose(h);
   // posisi yang ternyata sudah tidak ada (ditutup manual / EA mati lama) dibuang dari daftar
   for(int i = ArraySize(g_ticket) - 1; i >= 0; i--)
      if(!PositionSelectByTicket(g_ticket[i])) Untrack(g_ticket[i]);
   SavePos();
}

void SaveLastId()   { Rewrite("sniper_lastid.txt", "id=" + IntegerToString(g_lastId) + ";end=1"); }
void LoadLastId()
{
   string line;
   if(!ReadLastLine("sniper_lastid.txt", line)) return;
   string p[];
   StringSplit(line, ';', p);
   g_lastId = StringToInteger(Field(p, "id"));
}

//+------------------------------------------------------------------+
//| manajemen posisi: BE, 50% di TP1 lalu SL ke entry, TP2, time-stop |
//+------------------------------------------------------------------+
void ManagePositions()
{
   for(int i = ArraySize(g_ticket) - 1; i >= 0; i--)
   {
      ulong tk = g_ticket[i];
      if(!PositionSelectByTicket(tk)) { Untrack(tk); SavePos(); continue; }

      string sym = PositionGetString(POSITION_SYMBOL);
      bool buy   = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      double cur = PositionGetDouble(POSITION_PRICE_CURRENT);
      double vol = PositionGetDouble(POSITION_VOLUME);
      double sl  = PositionGetDouble(POSITION_SL);
      double r   = g_rdist[i] > 0 ? (buy ? (cur - g_entry[i]) : (g_entry[i] - cur)) / g_rdist[i] : 0;

      if(InBeAtR > 0 && !g_tp1Done[i] && r >= InBeAtR &&
         ((buy && sl < g_entry[i]) || (!buy && (sl > g_entry[i] || sl <= 0))))
      { trade.SetTypeFillingBySymbol(sym); trade.PositionModify(tk, g_entry[i], PositionGetDouble(POSITION_TP)); sl = g_entry[i]; }

      bool hitTp1 = g_tp1[i] > 0 && (buy ? cur >= g_tp1[i] : cur <= g_tp1[i]);
      if(hitTp1 && !g_tp1Done[i])
      {
         double vstep = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
         double vmin  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
         double closeV = vstep > 0 ? MathFloor(vol * InTP1Fraction / vstep + 1e-9) * vstep : 0;
         bool partial = false;
         if(closeV >= vmin && closeV < vol) { trade.SetTypeFillingBySymbol(sym); partial = trade.PositionClosePartial(tk, closeV); }
         g_tp1Done[i] = true;                       // satu kali saja, walau broker menolak partial (jangan loop)
         trade.SetTypeFillingBySymbol(sym);
         trade.PositionModify(tk, g_entry[i], g_tp2[i]);
         SavePos();
         Print("SniperBridge TP1 ", sym, " partial=", (partial ? "ya" : "tidak"), " volume sisa ", PositionGetDouble(POSITION_VOLUME));
      }

      if(InMaxHoldMin > 0 && TimeCurrent() - g_openAt[i] >= InMaxHoldMin * 60)
      {
         trade.SetTypeFillingBySymbol(sym);
         if(trade.PositionClose(tk)) { Untrack(tk); SavePos(); Print("SniperBridge TIME-STOP ", sym); }
      }
   }

   // halt harian dicek terus, bukan hanya saat ada order baru
   double real = RealizedToday();
   if(InProfitTargetUsd > 0 && real >= InProfitTargetUsd)  SetHalt("cap +$" + DoubleToString(InProfitTargetUsd, 2) + " tercapai", false);
   if(InMaxDailyLossUsd > 0 && real <= -InMaxDailyLossUsd) SetHalt("batas rugi harian -$" + DoubleToString(InMaxDailyLossUsd, 2), false);
   if(InMinEquityUsd > 0 && AccountInfoDouble(ACCOUNT_EQUITY) < InMinEquityUsd) SetHalt("equity di bawah floor saldo", true);
}

void CloseAll()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InMagic) continue;
      string sym = PositionGetString(POSITION_SYMBOL);
      trade.SetTypeFillingBySymbol(sym);
      trade.PositionClose(tk);
   }
}

//+------------------------------------------------------------------+
//| statistik trade: satu baris per deal PENUTUPAN milik EA ini        |
//| Ditulis ulang penuh (bukan append) supaya bridge tidak perlu       |
//| dedupe dan hasilnya tetap benar setelah EA/terminal restart.       |
//| Arah posisi dibaca dari deal MASUK — deal keluar bertipe berlawanan.|
//+------------------------------------------------------------------+
string DealReasonName(const long r)
{
   if(r == DEAL_REASON_SL)     return "SL";
   if(r == DEAL_REASON_TP)     return "TP";
   if(r == DEAL_REASON_SO)     return "STOP-OUT";
   if(r == DEAL_REASON_EXPERT) return "EA";        // time-stop / tutup sebagian TP1 / CLOSEALL
   return "MANUAL";                                 // CLIENT / MOBILE / WEB
}

void WriteTrades()
{
   if(GetTickCount() - g_tradesTick < 5000) return;
   g_tradesTick = GetTickCount();
   datetime off = TzOffset();
   datetime from = TimeCurrent() - (datetime)(InStatsDays > 0 ? InStatsDays * 86400 : 86400);
   if(!HistorySelect(from, TimeCurrent() + 60)) return;
   int n = HistoryDealsTotal();

   long   inId[];
   string inDir[];
   for(int i = 0; i < n; i++)
   {
      ulong dt = HistoryDealGetTicket(i);
      if(dt == 0) continue;
      if(HistoryDealGetInteger(dt, DEAL_MAGIC) != InMagic) continue;
      if(HistoryDealGetInteger(dt, DEAL_ENTRY) != DEAL_ENTRY_IN) continue;
      int k = ArraySize(inId);
      ArrayResize(inId, k + 1);
      ArrayResize(inDir, k + 1);
      inId[k]  = HistoryDealGetInteger(dt, DEAL_POSITION_ID);
      inDir[k] = (HistoryDealGetInteger(dt, DEAL_TYPE) == DEAL_TYPE_BUY) ? "BUY" : "SELL";
   }

   string rows[];
   for(int i = 0; i < n; i++)
   {
      ulong dt = HistoryDealGetTicket(i);
      if(dt == 0) continue;
      if(HistoryDealGetInteger(dt, DEAL_MAGIC) != InMagic) continue;
      long e = HistoryDealGetInteger(dt, DEAL_ENTRY);
      if(e != DEAL_ENTRY_OUT && e != DEAL_ENTRY_OUT_BY) continue;
      double usd = HistoryDealGetDouble(dt, DEAL_PROFIT) + HistoryDealGetDouble(dt, DEAL_SWAP)
                 + HistoryDealGetDouble(dt, DEAL_COMMISSION);
      long pid = HistoryDealGetInteger(dt, DEAL_POSITION_ID);
      string dir = "?";
      for(int k = 0; k < ArraySize(inId); k++)
         if(inId[k] == pid) { dir = inDir[k]; break; }
      int m = ArraySize(rows);
      ArrayResize(rows, m + 1);
      rows[m] = "end=1" +
        ";t="    + IntegerToString((long)(HistoryDealGetInteger(dt, DEAL_TIME) - off)) +
        ";sym="  + HistoryDealGetString(dt, DEAL_SYMBOL) +
        ";side=" + dir +
        ";vol="  + DoubleToString(HistoryDealGetDouble(dt, DEAL_VOLUME), 2) +
        ";usd="  + DoubleToString(usd, 2) +
        ";why="  + DealReasonName(HistoryDealGetInteger(dt, DEAL_REASON)) +
        ";pid="  + IntegerToString(pid) +
        ";id="   + IntegerToString((long)dt);
   }

   int total = ArraySize(rows);
   int cap   = InStatsMax > 0 ? InStatsMax : 300;
   int start = total > cap ? total - cap : 0;
   string outS = "";
   for(int i = start; i < total; i++) outS += rows[i] + "\n";
   // Berkas kosong = build baru, belum ada satu pun penutupan. Bridge membacanya sebagai
   // "stats tersedia, n=0"; kalau tidak pernah dibuat, panel mengira EA-nya build lama.
   if(outS == g_tradesCache && g_tradesSeen) return;
   g_tradesSeen  = true;
   g_tradesCache = outS;
   Rewrite("sniper_trades.txt", outS);
}

/* Bar 1 menit dari terminal sendiri, bukan dari bursa pihak ketiga. Scanner di bridge membangun
   sinyalnya dari harga yang sama dengan yang dipakai untuk eksekusi, jadi rencana tidak bisa
   ditolak guard "harga sudah lari" hanya karena feed luar berbeda beberapa dolar.
   Bar yang sedang berjalan dilewati (start_position=1): isinya berubah terus dan engine akan
   mendapatkannya dari tick tick di sniper_status.txt. Karena itu isi berkas ini hanya berubah
   saat menit berganti, dan cache di bawah menghentikan tulis-ulang yang tidak perlu. */
void WriteBars()
{
   if(InStatsBars <= 0) return;
   datetime off = TzOffset();
   string outS = "";
   string syms[];
   int n = StringSplit(InSymbols, ',', syms);
   for(int i = 0; i < n; i++)
   {
      string sym = syms[i];
      if(sym == "") continue;
      if(!SymbolSelect(sym, true)) continue;
      MqlRates r[];
      int got = CopyRates(sym, PERIOD_M1, 1, InStatsBars, r);
      if(got <= 0) continue;
      int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      string body = "";
      for(int j = 0; j < got; j++)
      {
         if(body != "") body += "|";
         body += IntegerToString((long)(r[j].time - off)) + "," +
                 DoubleToString(r[j].open, digits)  + "," +
                 DoubleToString(r[j].high, digits)  + "," +
                 DoubleToString(r[j].low, digits)   + "," +
                 DoubleToString(r[j].close, digits);
      }
      outS += "end=1;sym=" + sym + ";tf=1m;n=" + IntegerToString(got) + ";bars=" + body + "\n";
   }
   if(outS == "" || outS == g_barsCache) return;
   g_barsCache = outS;
   Rewrite("sniper_bars.txt", outS);
}

//+------------------------------------------------------------------+
//| status untuk bridge                                               |
//+------------------------------------------------------------------+
void WriteStatus()
{
   string s = "end=1";
   s += ";ts=" + IntegerToString((long)TimeGMT());
   s += ";login=" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   s += ";server=" + AccountInfoString(ACCOUNT_SERVER);
   s += ";company=" + AccountInfoString(ACCOUNT_COMPANY);
   long tm = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   s += ";trade_mode=" + (tm == ACCOUNT_TRADE_MODE_DEMO ? "demo" : (tm == ACCOUNT_TRADE_MODE_REAL ? "real" : "contest"));
   s += ";trade_allowed=" + (AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) ? "1" : "0");
   s += ";trade_expert=" + (AccountInfoInteger(ACCOUNT_TRADE_EXPERT) ? "1" : "0");
   s += ";balance=" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2);
   s += ";equity=" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2);
   s += ";margin_free=" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2);
   s += ";margin_level=" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 1);
   s += ";leverage=" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE));
   s += ";realized_today=" + DoubleToString(RealizedToday(), 2);
   s += ";halt=" + g_halt + (g_haltPerm ? " (permanen)" : "");
   s += ";build=" + TimeToString(__DATETIME__, TIME_DATE | TIME_MINUTES);   // waktu compile build yang jalan — compile ulang TIDAK otomatis me-reload chart
   s += ";lastid=" + IntegerToString(g_lastId);
   s += ";open=" + IntegerToString(MyPositions());
   s += ";openrisk=" + DoubleToString(TotalOpenRiskUsd(), 2);
   s += ";day=" + IntegerToString((long)g_haltDay);

   int k = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InMagic) continue;
      k++;
      s += ";pos" + IntegerToString(k) + "=" + PositionGetString(POSITION_SYMBOL) + ":" + IntegerToString(tk) + ":" +
           DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + ":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 6) + ":" +
           DoubleToString(PositionGetDouble(POSITION_SL), 6) + ":" + DoubleToString(PositionGetDouble(POSITION_TP), 6) + ":" +
           DoubleToString(PositionGetDouble(POSITION_PROFIT), 2);
   }

   string syms[];
   int n = StringSplit(InSymbols, ',', syms);
   for(int i = 0; i < n; i++)
   {
      string sym = syms[i];
      if(sym == "") continue;
      if(!SymbolSelect(sym, true)) continue;
      double point = PointOf(sym);
      double ask = SymbolInfoDouble(sym, SYMBOL_ASK), bid = SymbolInfoDouble(sym, SYMBOL_BID);
      if(point <= 0 || ask <= 0 || bid <= 0) continue;
      int d = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      double atr = AtrPoints(sym);
      s += ";mkt" + IntegerToString(i + 1) + "=" + sym + ":" + DoubleToString((ask - bid) / point, 0) + ":" +
           DoubleToString(ask, d) + ":" + DoubleToString(bid, d) + ":" + DoubleToString(atr, 0);
   }
   Rewrite("sniper_status.txt", s);
}

// ATR(14) pada InAtrTF, dalam points broker — hanya informasi untuk laporan;
// gerbang ATR/biaya yang menentukan entry dihitung scanner dari bar BAR_MIN.
double AtrPoints(const string sym)
{
   int h = (int)iATR(sym, InAtrTF, 14);
   if(h == INVALID_HANDLE) return 0;
   double buf[];
   if(CopyBuffer(h, 0, 1, 1, buf) < 1) return 0;
   double point = PointOf(sym);
   return point > 0 ? buf[0] / point : 0;
}

//+------------------------------------------------------------------+
//| Hitung CCI 45 Median HL/2 untuk BTS Strategy                     |
//+------------------------------------------------------------------+
double CalcCCI45(const string sym, const int shift = 0)
{
   int h = (int)iCCI(sym, PERIOD_CURRENT, InCCIPeriod, PRICE_MEDIAN);
   if(h == INVALID_HANDLE) return 0.0;
   double buf[];
   double res = 0.0;
   if(CopyBuffer(h, 0, shift, 1, buf) >= 1) res = buf[0];
   IndicatorRelease(h);
   return res;
}

//+------------------------------------------------------------------+
//| Hitung EMA 200 Close untuk BTS Strategy baseline                 |
//+------------------------------------------------------------------+
double CalcEMA200(const string sym, const int shift = 0)
{
   int h = (int)iMA(sym, PERIOD_CURRENT, InBTSEMAPeriod, 0, MODE_EMA, PRICE_CLOSE);
   if(h == INVALID_HANDLE) return 0.0;
   double buf[];
   double res = 0.0;
   if(CopyBuffer(h, 0, shift, 1, buf) >= 1) res = buf[0];
   IndicatorRelease(h);
   return res;
}
//+------------------------------------------------------------------+
