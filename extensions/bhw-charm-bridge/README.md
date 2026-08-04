# BHW Charm Draft Bridge — Amaris Pilot

This Manifest V3 browser extension transfers a provider-approved packet from BHW Encounter Operations into text fields on an open CharmHealth encounter.

## Safety boundary

- Runs only on `*.charmhealth.com` and `*.charmtracker.com`.
- Makes no network requests and stores no packet or note data.
- Requires a provider-approved BHW packet and a manual patient/encounter match confirmation.
- Enters text only into clearly labeled note, CPT/HCPCS, or ICD-10-CM fields.
- Never clicks Save, Sign, Submit, Prescribe, Release, or a claim action.
- If it cannot identify a safe note field, it stops without entering anything.

## Install for the pilot

1. Download and unzip the pilot package.
2. In Google Chrome, open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose the unzipped `bhw-charm-bridge` folder.
5. Pin **BHW Charm Draft Bridge (Pilot)** to the toolbar.
6. Test first with a synthetic training encounter.

## Use

1. In BHW Encounter Operations, audit and approve the encounter.
2. Choose **Copy Charm packet**.
3. Open and personally match the correct patient and encounter in CharmHealth.
4. Open the extension, paste the packet, and choose **Check open Charm chart**.
5. Confirm the match and choose **Fill approved draft fields**.
6. Review every entered field in CharmHealth before saving or signing it yourself.

CharmHealth interfaces can change. If the extension does not detect the correct fields, stop and report the field labels shown in CharmHealth so the mapping can be updated safely.
