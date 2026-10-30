import { Linking } from "react-native";

const webUrl = /^https?:\/\//i;

export function openWebUrl(url: string) {
  if (!webUrl.test(url)) return Promise.reject(new Error("Only http and https links can be opened"));
  return Linking.openURL(url);
}
