type Coordinate = { latitude: number; longitude: number };

/**
 * Creates a Google Maps directions deep link for an observed SF destination.
 * It never contains an origin: Google Maps obtains the device's current
 * location locally when the recipient opens the link.
 */
export function buildGoogleMapsDirectionsUrl(input: {
  destination: Coordinate;
  travelMode?: "bicycling" | "driving" | "transit" | "walking";
}): string {
  if (!isSanFranciscoCoordinate(input.destination)) {
    throw new Error("MAP_DESTINATION_OUTSIDE_SF");
  }

  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", coordinateValue(input.destination));
  url.searchParams.set("travelmode", input.travelMode ?? "walking");

  return url.toString();
}

function isSanFranciscoCoordinate(value: Coordinate): boolean {
  return (
    isEarthCoordinate(value) &&
    value.latitude >= 37.6 &&
    value.latitude <= 37.9 &&
    value.longitude >= -122.6 &&
    value.longitude <= -122.3
  );
}

function isEarthCoordinate(value: Coordinate): boolean {
  return (
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    value.longitude >= -180 &&
    value.longitude <= 180
  );
}

function coordinateValue(value: Coordinate): string {
  return `${value.latitude.toFixed(6)},${value.longitude.toFixed(6)}`;
}
