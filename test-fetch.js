// Quick connectivity + data-shape test against Bitget public market data (no API key needed)
async function main() {
  const url = 'https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=usdt-futures&granularity=1H&limit=5';
  try {
    const res = await fetch(url);
    const json = await res.json();
    console.log('HTTP', res.status, 'code', json.code, 'msg', json.msg);
    if (Array.isArray(json.data)) {
      console.log('rows:', json.data.length);
      console.log('sample row [ts, o, h, l, c, baseVol, quoteVol]:');
      console.log(json.data[json.data.length - 1]);
      const last = json.data[json.data.length - 1];
      console.log('last candle time:', new Date(Number(last[0])).toISOString(), 'close:', last[4]);
    } else {
      console.log('Unexpected data:', JSON.stringify(json).slice(0, 300));
    }
  } catch (e) {
    console.log('FETCH ERROR:', e.message);
  }
}
main();
