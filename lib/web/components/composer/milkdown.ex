defmodule Bonfire.Editor.Milkdown do
  use Bonfire.UI.Common.Web, :stateless_component

  # use Bonfire.UI.Common.Web, :stateless_component
  # use Bonfire.Common.Utils

  prop smart_input_opts, :map, default: %{}
  prop field_name, :string, default: "post[post_content][html_body]", required: false
  prop textarea_class, :css_class, default: "w-full md:min-h-[280px] h-full"
  prop reset_smart_input, :boolean, default: false
  prop showing_within, :atom

  # needed by apps to use this editor to know how to process text they receive from it
  def output_format, do: :markdown
end
