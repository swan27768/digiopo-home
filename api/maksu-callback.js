// DigiOpo – Paytrail-maksun callback (palvelin)
// GET /api/maksu-callback?checkout-...=...&signature=...
//
// Tämän kutsuu PAYTRAILIN PALVELIN suoraan, ostajan selaimesta riippumatta. Se on
// luotettava vahvistuskanava: vaikka ostaja sulkisi välilehden maksettuaan, tämä
// callback tulee silti ja täyttää tilauksen. Paytrail voi myös yrittää uudelleen,
// joten käsittely on idempotentti (jaettu maksu-kasittely.js:n kanssa).
//
// Vastaus on aina 200, jottei Paytrail tulkitse käsittelyä epäonnistuneeksi ja
// jää turhaan uusimaan jo onnistunutta vahvistusta. Mahdolliset virheet kirjataan
// api_virheet-tauluun käsittelyn sisällä, eivät HTTP-statukseen.

import { kasitteleMaksuVahvistus } from './_lib/maksu-kasittely.js';

export default async function handler(req, res) {
  const query = req.query || {};
  try {
    await kasitteleMaksuVahvistus(query);
  } catch (err) {
    console.error('maksu-callback käsittely kaatui:', err.message);
  }
  return res.status(200).send('OK');
}
