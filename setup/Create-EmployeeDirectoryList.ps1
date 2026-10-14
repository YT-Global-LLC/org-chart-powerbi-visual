<#
.SYNOPSIS
    Creates the "Employee Directory" SharePoint list used by the Org Chart by YT Global Power BI visual,
    and (optionally) loads rows from a CSV.

.REQUIREMENTS
    PowerShell 7.2+ and PnP.PowerShell 2.x:   Install-Module PnP.PowerShell -Scope CurrentUser
    An Entra ID app registration for PnP (one-time per tenant):
        Register-PnPEntraIDAppForInteractiveLogin -ApplicationName "PnP Org Chart" -Tenant contoso.onmicrosoft.com -Interactive

.EXAMPLE
    ./Create-EmployeeDirectoryList.ps1 -SiteUrl https://contoso.sharepoint.com/sites/HR -ClientId <app-guid> -CsvPath ./sample-employees.csv
#>
param(
    [Parameter(Mandatory)] [string] $SiteUrl,
    [Parameter(Mandatory)] [string] $ClientId,
    [string] $ListTitle = "Employee Directory",
    [string] $CsvPath
)

$ErrorActionPreference = "Stop"
Connect-PnPOnline -Url $SiteUrl -ClientId $ClientId -Interactive

# ---------------------------------------------------------------- list
$list = Get-PnPList -Identity $ListTitle -ErrorAction SilentlyContinue
if (-not $list) {
    Write-Host "Creating list '$ListTitle'..." -ForegroundColor Cyan
    $list = New-PnPList -Title $ListTitle -Template GenericList -Url "Lists/EmployeeDirectory" -OnQuickLaunch
}

# Rename the built-in Title column to "Full Name"
Set-PnPField -List $ListTitle -Identity "Title" -Values @{ Title = "Full Name" } | Out-Null

function Add-FieldIfMissing {
    param([string]$InternalName, [string]$DisplayName, [string]$Type, [hashtable]$Extra = @{})
    $existing = Get-PnPField -List $ListTitle -Identity $InternalName -ErrorAction SilentlyContinue
    if ($existing) { Write-Host "  - $DisplayName exists"; return }
    $p = @{ List = $ListTitle; InternalName = $InternalName; DisplayName = $DisplayName; Type = $Type; AddToDefaultView = $true }
    $f = Add-PnPField @p
    # Indexing must happen before unique values can be enforced, so apply it first.
    if ($Extra.ContainsKey("Indexed")) {
        Set-PnPField -List $ListTitle -Identity $InternalName -Values @{ Indexed = $Extra["Indexed"] } | Out-Null
        $Extra.Remove("Indexed")
    }
    if ($Extra.Count) { Set-PnPField -List $ListTitle -Identity $InternalName -Values $Extra | Out-Null }
    Write-Host "  + $DisplayName" -ForegroundColor Green
}

Write-Host "Adding columns..." -ForegroundColor Cyan
Add-FieldIfMissing "EmployeeID" "Employee ID" "Text" @{ Required = $true; EnforceUniqueValues = $true; Indexed = $true }
Add-FieldIfMissing "ManagerID"  "Manager ID"  "Text" @{ Indexed = $true; Description = "Employee ID of this person's manager. Leave blank for the top of the org." }
Add-FieldIfMissing "JobTitle"   "Job Title"   "Text"
Add-FieldIfMissing "Department" "Department"  "Text"
Add-FieldIfMissing "WorkEmail"  "Email"       "Text"
Add-FieldIfMissing "Phone"      "Phone"       "Text"
Add-FieldIfMissing "OfficeLocation" "Location" "Text"
Add-FieldIfMissing "PhotoUrl"   "Photo URL"   "Text" @{ Description = "Link to a small photo in this site (about 100 px). Blank = initials." }
Add-FieldIfMissing "IsActive"   "Active"      "Boolean" @{ DefaultValue = "1" }

# ---------------------------------------------------------------- data
if ($CsvPath) {
    Write-Host "Importing $CsvPath ..." -ForegroundColor Cyan
    $rows = Import-Csv $CsvPath
    $batch = New-PnPBatch
    foreach ($r in $rows) {
        Add-PnPListItem -List $ListTitle -Batch $batch -Values @{
            Title          = $r.FullName
            EmployeeID     = $r.EmployeeID
            ManagerID      = $r.ManagerID
            JobTitle       = $r.JobTitle
            Department     = $r.Department
            WorkEmail      = $r.Email
            Phone          = $r.Phone
            OfficeLocation = $r.Location
            PhotoUrl       = $r.PhotoUrl
            IsActive       = $true
        } | Out-Null
    }
    Invoke-PnPBatch -Batch $batch
    Write-Host "Imported $($rows.Count) rows." -ForegroundColor Green
}

Write-Host "Done. List URL: $SiteUrl/Lists/EmployeeDirectory" -ForegroundColor Green
