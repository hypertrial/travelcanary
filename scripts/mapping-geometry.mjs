export function radiusRing([longitude, latitude], radiusKm, steps = 24) {
  const latitudeScale = 110.574;
  const longitudeScale = 111.32 * Math.max(0.1, Math.cos(latitude * Math.PI / 180));
  const ring = Array.from({ length: steps }, (_, index) => {
    const angle = index / steps * Math.PI * 2;
    return [longitude + Math.cos(angle) * radiusKm / longitudeScale, latitude + Math.sin(angle) * radiusKm / latitudeScale];
  });
  return [...ring, ring[0]];
}
