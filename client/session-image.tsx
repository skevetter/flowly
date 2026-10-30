import { useEffect, useState } from "react";
import { Animated, Image, Platform, Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { imageHost, isRemoteImage, localImagePath, mayRequestImage, type ImageRef } from "../shared/images";
import { useBoardView } from "./board-view";
import { Modal } from "./modal";
import { Button, Label, Theme, font, message, noFocusRing, radius, useTheme } from "./ui";
import { motionDuration, useMotionValue } from "./motion";
import { t } from "../shared/i18n";

const approvedSources = new Set<string>();

export function SessionImage({
  taskId,
  agentId,
  image,
  maxWidth = 360,
}: {
  taskId: string;
  agentId: string;
  image: ImageRef;
  /** Upper bound; small images keep their natural width (never upscaled). */
  maxWidth?: number;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const read = useRpc(rpc.sessionImage);
  const local = localImagePath(image.src);
  const served = useQuery({
    queryKey: ["flowly", "image", agentId, image.src],
    queryFn: () => read({ taskId, agentId, src: image.src }),
    enabled: !!local,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
  const autoLoadRemote = useBoardView().values?.loadRemoteImages ?? false;
  const [approved, setApproved] = useState(approvedSources.has(image.src));
  const withheld = !mayRequestImage(image.src, { autoLoadRemote, approved });
  const uri = withheld ? undefined : local ? served.data?.dataUri : image.src;
  const [natural, setNatural] = useState(0);
  const [ratio, setRatio] = useState(4 / 3),
    [loaded, setLoaded] = useState(false),
    [failed, setFailed] = useState(""),
    [open, setOpen] = useState(false);
  useEffect(() => {
    // RN-web's onLoad carries no size; ask for it directly. Native onLoad
    // reports the source size, so a second decode of the image is skipped.
    if (!uri || Platform.OS !== "web") return;
    let alive = true;
    Image.getSize(
      uri,
      (width, height) => {
        if (!alive || !width || !height) return;
        setRatio(Math.max(0.5, Math.min(3, width / height)));
        setNatural(Math.max(48, width));
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [uri]);
  const fade = useMotionValue(loaded ? 1 : 0, motionDuration.forward, 0);
  const error = failed || (served.error ? message(served.error) : "");
  if (withheld && isRemoteImage(image.src))
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
        <Button small icon="Image" onPress={() => {
            approvedSources.add(image.src);
            setApproved(true);
          }}>
          {t("Load image")}
        </Button>
        <View style={{ flexShrink: 1 }}>
          <Label muted size={font.sm} lines={1}>{image.alt ? `${image.alt} (${imageHost(image.src)})` : imageHost(image.src)}</Label>
        </View>
      </View>
    );
  if (error)
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}>
        <Icon name="ImageOff" size={14} color={colors.foregroundMuted} />
        <View style={{ flexShrink: 1 }}>
          <Label muted size={font.sm} lines={2}>{image.alt}: {error}</Label>
        </View>
      </View>
    );
  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={t("{alt}. Open larger", { alt: image.alt })}
        onPress={() => uri && setOpen(true)}
        style={{ ...noFocusRing, width: "100%", maxWidth: natural ? Math.min(natural, maxWidth) : maxWidth }}
      >
        <View
          style={{
            width: "100%",
            aspectRatio: ratio,
            maxHeight: 320,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface2,
            overflow: "hidden",
          }}
        >
          {uri && (
            <Animated.View style={{ flex: 1, opacity: fade }}>
              <Image
                source={{ uri }}
                resizeMode="cover"
                style={{ width: "100%", height: "100%" }}
                onLoad={(event) => {
                  const source = (event.nativeEvent as { source?: { width?: number; height?: number } }).source;
                  if (source?.width && source.height) {
                    setRatio(Math.max(0.5, Math.min(3, source.width / source.height)));
                    setNatural(Math.max(48, source.width));
                  }
                  setLoaded(true);
                }}
                onError={() => setFailed(t("could not be displayed"))}
              />
            </Animated.View>
          )}
        </View>
      </Pressable>
      <Modal open={open} title={image.alt || t("Image")} onOpenChange={(next) => !next && setOpen(false)}>
        <Modal.Content>
          <Theme.Provider value={theme}>
            {uri && (
              <Image
                source={{ uri }}
                resizeMode="contain"
                accessibilityLabel={image.alt}
                style={{ width: "100%", aspectRatio: ratio, maxHeight: 640 }}
              />
            )}
          </Theme.Provider>
        </Modal.Content>
      </Modal>
    </>
  );
}
