// Properties the bridge exposes to Home Assistant (ADR 0012). A whitelist keeps the snapshot
// small and leaves out values that are useless or private (pictures, serials, cloud URLs).
// Values come from the device list at login and are updated over P2P afterwards.

export const CAMERA_PROPERTIES = Object.freeze([
  // writable over P2P
  "enabled", "motionDetection", "motionDetectionSensitivity", "motionDetectionType",
  "light", "lightSettingsBrightnessManual", "nightvision", "statusLed", "microphone",
  "speaker", "speakerVolume", "audioRecording", "antitheftDetection", "recordingClipLength",
  "recordingRetriggerInterval", "recordingEndClipMotionStops", "powerWorkingMode",
  "powerSource", "notificationType", "watermark", "videoStreamingQuality", "videoRecordingQuality",
  // read-only
  "batteryTemperature", "chargingStatus", "wifiRssi", "wifiSignalLevel", "softwareVersion",
  "hardwareVersion", "snooze", "snoozeTime", "batteryUsageLastWeek", "lastChargingDays",
  "lastChargingRecordedEvents", "lastChargingFalseEvents", "lastChargingTotalEvents",
]);

export const STATION_PROPERTIES = Object.freeze([
  // writable over P2P
  "alarmVolume", "promptVolume", "alarmTone", "timeFormat", "notificationSwitchModeSchedule",
  "notificationSwitchModeGeofence", "notificationSwitchModeApp", "notificationSwitchModeKeypad",
  "notificationStartAlarmDelay",
  // read-only (the library has no setter for the delays)
  "alarm", "alarmType", "alarmArmDelay", "alarmDelay", "currentMode", "sdStatus", "sdCapacity",
  "sdCapacityAvailable", "softwareVersion", "hardwareVersion", "lanIpAddress",
]);

/** The whitelisted subset of `values` (a library `getProperties()` result). */
export function pick(values, names) {
  const out = {};
  for (const name of names) if (values?.[name] !== undefined) out[name] = values[name];
  return out;
}

// motionDetectionType: 0 = humans only, 2 = all motions.
export const HUMANS_ONLY = 0;
