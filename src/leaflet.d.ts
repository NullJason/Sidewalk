declare module "leaflet" {
  export class Map {
    constructor(element: string | HTMLElement, options?: unknown);
    setView(center: [number, number], zoom: number, options?: unknown): this;
    invalidateSize(): this;
  }
  export class LayerGroup {
    addTo(map: Map): this;
    clearLayers(): this;
  }
  export class Marker {
    addTo(group: LayerGroup): this;
    bindPopup(content: string): this;
    openPopup(): this;
  }
  export interface MarkerOptions {
    icon?: Icon;
  }
  export interface IconOptions {
    iconUrl: string;
    iconSize?: [number, number];
    iconAnchor?: [number, number];
    popupAnchor?: [number, number];
    shadowUrl?: string;
  }
  
  export class Icon {
    constructor(options: IconOptions);
  }
  export function map(element: string | HTMLElement, options?: unknown): Map;
  export function tileLayer(url: string, options?: unknown): { addTo(map: Map): unknown };
  export function layerGroup(): LayerGroup;
  export function marker(position: [number, number], options? : MarkerOptions): Marker;
  export function icon(options: IconOptions): Icon;
}
