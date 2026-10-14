// Org Chart by YT Global: Power Query for a Microsoft SharePoint "Employee Directory" list
//
// Power BI Desktop > Home > Get data > Blank query > Advanced Editor > paste all of this > Done.
// Rename the query "Employees", sign in with "Organizational account" when asked, then Close & Apply.
// Change the three settings below to match your site.

let
    // ----------------------------------------------------------------- settings
    SiteUrl     = "https://contoso.sharepoint.com/sites/HR",   // your SharePoint site
    ListName    = "Employee Directory",                        // your list's title
    PhotoSource = "list",   // "list"    = use the Photo URL column (blank rows show initials)
                            // "profile" = use each person's Microsoft 365 profile photo (by Email)
                            // "none"    = initials only (fastest refresh)

    // ----------------------------------------------------------------- read the list
    Source   = SharePoint.Tables(SiteUrl, [Implementation = "2.0", ViewMode = "All"]),
    ListData = Source{[Title = ListName]}[Items],

    Kept = Table.SelectColumns(
        ListData,
        {"Employee ID", "Manager ID", "Full Name", "Job Title", "Department",
         "Email", "Phone", "Location", "Photo URL", "Active"},
        MissingField.UseNull
    ),

    ActiveOnly = Table.SelectRows(Kept, each [Active] = null or [Active] = true),

    Typed = Table.TransformColumnTypes(ActiveOnly, {
        {"Employee ID", type text}, {"Manager ID", type text}, {"Full Name", type text},
        {"Job Title", type text},   {"Department", type text}, {"Email", type text},
        {"Phone", type text},       {"Location", type text},   {"Photo URL", type text}
    }),

    // Trim keys so " 1002" and "1002" match; a blank manager means top of the org
    Clean = Table.TransformColumns(Typed, {
        {"Employee ID", each if _ = null then null else Text.Trim(_), type text},
        {"Manager ID",  each if _ = null or Text.Trim(_) = "" then null else Text.Trim(_), type text}
    }),

    // ----------------------------------------------------------------- photos
    // The visual makes no web requests, so Power Query downloads each photo and
    // embeds it as text (a data URI). Keep photos small (about 100 px, under 20 KB).
    TenantRoot = Text.Combine(List.FirstN(Text.Split(SiteUrl, "/"), 3), "/"),   // https://contoso.sharepoint.com

    ToDataUri = (bin as binary) as nullable text =>
        let b64 = Binary.ToText(bin, BinaryEncoding.Base64)
        in  if Text.Length(b64) > 30000 then null else "data:image/jpeg;base64," & b64,

    FromList = (url as nullable text) as nullable text =>
        let
            u    = if url = null then "" else Text.Trim(Text.BeforeDelimiter(url, ",")),
            path = if Text.StartsWith(u, TenantRoot) then Text.Range(u, Text.Length(TenantRoot)) else u,
            rel  = Text.Replace(if Text.StartsWith(path, "/") then Text.Range(path, 1) else path, "%20", " ")
        in
            if rel = "" then null
            else try ToDataUri(Web.Contents(TenantRoot, [RelativePath = rel])) otherwise null,

    FromProfile = (email as nullable text) as nullable text =>
        if email = null or Text.Trim(email) = "" then null
        else try ToDataUri(Web.Contents(TenantRoot, [
                RelativePath = "_layouts/15/userphoto.aspx",
                Query = [size = "M", accountname = Text.Trim(email)]
             ])) otherwise null,

    WithPhoto = Table.AddColumn(Clean, "Photo", each
        if PhotoSource = "list" then FromList([Photo URL])
        else if PhotoSource = "profile" then FromProfile([Email])
        else null, type text),

    Result = Table.RemoveColumns(WithPhoto, {"Active", "Photo URL"})
in
    Result


/* ---------------------------------------------------------------------------
   ALTERNATIVE: your list has a Person column called "Manager" instead of a
   Manager ID text column. Key everyone by email instead. Replace the Kept step's
   input with:

    WithIds = Table.AddColumn(
                Table.AddColumn(ListData, "Manager ID",
                    each try Text.Lower([Manager][email]) otherwise null, type text),
                "Employee ID", each Text.Lower([Email]), type text),

   and select from WithIds instead of ListData.

   TROUBLESHOOTING
   * "Formula.Firewall" error with photos: File > Options and settings > Data source
     settings > set the SharePoint site's privacy level to Organizational.
   * Scheduled refresh in the Power BI service: set the data source credentials to
     OAuth2 (Organizational account) on the semantic model's settings page.
--------------------------------------------------------------------------- */
