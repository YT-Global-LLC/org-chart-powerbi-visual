"use strict";

import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

const orientationItems = [
    { value: "vertical", displayName: "Top to bottom" },
    { value: "horizontal", displayName: "Left to right" }
];

class LayoutCard extends FormattingSettingsCard {
    orientation = new formattingSettings.ItemDropdown({
        name: "orientation",
        displayName: "Orientation",
        items: orientationItems,
        value: orientationItems[0]
    });

    initialDepth = new formattingSettings.NumUpDown({
        name: "initialDepth",
        displayName: "Levels expanded on load",
        value: 2,
        options: {
            minValue: { type: powerbi.visuals.ValidatorType.Min, value: 1 },
            maxValue: { type: powerbi.visuals.ValidatorType.Max, value: 20 }
        }
    });

    levelSpacing = new formattingSettings.NumUpDown({
        name: "levelSpacing",
        displayName: "Level spacing",
        value: 70,
        options: {
            minValue: { type: powerbi.visuals.ValidatorType.Min, value: 20 },
            maxValue: { type: powerbi.visuals.ValidatorType.Max, value: 400 }
        }
    });

    siblingSpacing = new formattingSettings.NumUpDown({
        name: "siblingSpacing",
        displayName: "Sibling spacing",
        value: 24,
        options: {
            minValue: { type: powerbi.visuals.ValidatorType.Min, value: 4 },
            maxValue: { type: powerbi.visuals.ValidatorType.Max, value: 200 }
        }
    });

    showSearch = new formattingSettings.ToggleSwitch({
        name: "showSearch",
        displayName: "Show toolbar (search, expand, fit)",
        value: true
    });

    name = "layout";
    displayName = "Layout";
    slices: FormattingSettingsSlice[] = [this.orientation, this.initialDepth, this.levelSpacing, this.siblingSpacing, this.showSearch];
}

class CardsCard extends FormattingSettingsCard {
    background = new formattingSettings.ColorPicker({ name: "background", displayName: "Card background", value: { value: "#FFFFFF" } });
    textColor = new formattingSettings.ColorPicker({ name: "textColor", displayName: "Name color", value: { value: "#1F2328" } });
    subTextColor = new formattingSettings.ColorPicker({ name: "subTextColor", displayName: "Title color", value: { value: "#5B6470" } });

    fontSize = new formattingSettings.NumUpDown({
        name: "fontSize",
        displayName: "Text size",
        value: 12,
        options: {
            minValue: { type: powerbi.visuals.ValidatorType.Min, value: 8 },
            maxValue: { type: powerbi.visuals.ValidatorType.Max, value: 24 }
        }
    });

    cornerRadius = new formattingSettings.NumUpDown({
        name: "cornerRadius",
        displayName: "Corner radius",
        value: 10,
        options: {
            minValue: { type: powerbi.visuals.ValidatorType.Min, value: 0 },
            maxValue: { type: powerbi.visuals.ValidatorType.Max, value: 30 }
        }
    });

    showPhoto = new formattingSettings.ToggleSwitch({ name: "showPhoto", displayName: "Show photo / initials", value: true });
    showDepartment = new formattingSettings.ToggleSwitch({ name: "showDepartment", displayName: "Show department", value: true });
    showReportCount = new formattingSettings.ToggleSwitch({ name: "showReportCount", displayName: "Show report counts", value: true });

    name = "cards";
    displayName = "Cards";
    slices: FormattingSettingsSlice[] = [
        this.background, this.textColor, this.subTextColor, this.fontSize, this.cornerRadius,
        this.showPhoto, this.showDepartment, this.showReportCount
    ];
}

class ColorsCard extends FormattingSettingsCard {
    colorByDepartment = new formattingSettings.ToggleSwitch({ name: "colorByDepartment", displayName: "Color by department", value: true });
    accentColor = new formattingSettings.ColorPicker({ name: "accentColor", displayName: "Accent color", value: { value: "#2563EB" } });
    linkColor = new formattingSettings.ColorPicker({ name: "linkColor", displayName: "Connector color", value: { value: "#B7BEC8" } });

    linkWidth = new formattingSettings.NumUpDown({
        name: "linkWidth",
        displayName: "Connector width",
        value: 1.5,
        options: {
            minValue: { type: powerbi.visuals.ValidatorType.Min, value: 0.5 },
            maxValue: { type: powerbi.visuals.ValidatorType.Max, value: 8 }
        }
    });

    name = "colors";
    displayName = "Colors";
    slices: FormattingSettingsSlice[] = [this.colorByDepartment, this.accentColor, this.linkColor, this.linkWidth];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    layoutCard = new LayoutCard();
    cardsCard = new CardsCard();
    colorsCard = new ColorsCard();

    cards = [this.layoutCard, this.cardsCard, this.colorsCard];
}

