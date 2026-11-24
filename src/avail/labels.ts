/**
 * Port label vocabulary shared by the linter and the normalizer: abbreviations written in
 * capitals on panels (HDMI, LAN, IPCP, COM, RS-232…). Pure, no dependencies.
 */

/** Abbreviations kept in capitals (key: upper case → written form). */
export const ABBREVIATIONS = new Map(
  [
    "HDMI", "USB", "LAN", "WAN", "DTP", "DTP2", "DTP3", "XTP", "IR", "DSP", "AEC", "SDI", "DP", "DVI", "VGA", "AV", "AVB", "SFP", "SFP+",
    "AES", "AES67", "XLR", "TRS", "RCA", "CEC", "EDID", "HDCP", "GPIO", "I/O", "DC", "AC", "PC", "TV", "RF", "HD", "ID", "IP", "LED",
    "OOB", "KVM", "DMX", "MIDI", "NDI", "MADI", "ADAT", "PTZ", "VC", "HDBT", "HDBASET", "RS-232", "RS-422", "RS-485", "RS232",
    "RS422", "RS485", "EXP", "ACP", "SPDIF", "S/PDIF", "OSD", "UHD", "4K", "8K", "BNC", "PSU", "PGM", "PVW", "AUX", "L", "R",
    "IPCP", "HID", "TX", "RX", "COM", "DMP", "VISCA", "RS", "RJ", "ARC", "TOSLINK", "GPU", "UTP", "SD", "CCU", "NHD", "IEC",
    "PAL", "NTSC", "TC", "PWR", "MGMT", "PA", "DHCP", "SNMP", "SIP", "VOIP", "POTS",
  ].map((a) => [a, a] as [string, string]).concat([["POE", "PoE"], ["POE+", "PoE+"], ["POE++", "PoE++"], ["EBUS", "eBUS"], ["EARC", "eARC"]]),
);

const LATIN_WORD = /[A-Za-z]{2,}/;

/**
 * true when every word of the label is a known abbreviation or a number ("IPCP LAN", "USB HID",
 * "AV LAN", "COM 1", "RS-232/IR"): written in capitals on the panel, not an all-caps label.
 */
export function onlyAbbreviations(label: string): boolean {
  const tokens = label.match(/[A-Za-z0-9+][A-Za-z0-9+/-]*/g) ?? [];
  if (!tokens.some((t) => LATIN_WORD.test(t))) return false;
  return tokens.every((t) => {
    if (!/[A-Za-z]/.test(t)) return true; // numbers: 1, 232
    if (ABBREVIATIONS.has(t.toUpperCase())) return true;
    return t.split(/[/-]/).filter(Boolean).every((w) => !/[A-Za-z]/.test(w) || ABBREVIATIONS.has(w.toUpperCase()) || w.length === 1);
  });
}
